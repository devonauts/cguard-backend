/**
 * Attendance admin service (Nómina). Powers the admin API: list/find attendance
 * records (reusing GuardShiftRepository's ACL + filters), the dashboard summary,
 * the exceptions queue, approvals, manual corrections (original value preserved),
 * and the per-tenant settings. Mirrors the memos service shape: `new
 * AttendanceAdminService(req)` then call a method. Every mutation is audited and,
 * where relevant, dispatches a notification.
 */

import { Op } from 'sequelize';
import { IServiceOptions } from './IServiceOptions';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import GuardShiftRepository from '../database/repositories/guardShiftRepository';
import AuditLogRepository from '../database/repositories/auditLogRepository';
import Error400 from '../errors/Error400';
import Error404 from '../errors/Error404';
import { getNominaSettings, mergeNominaSettings } from '../lib/nominaSettings';
import { dispatch } from '../lib/notificationDispatcher';
import { pushToUser } from './pushService';
import { ymd } from './consignaRecurrence';
import { wallClockToUtc } from '../lib/tenantTime';

export default class AttendanceAdminService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  private get db() {
    return this.options.database;
  }
  private get tenantId() {
    return SequelizeRepository.getCurrentTenant(this.options).id;
  }

  /** Tenant-local [startOfToday, startOfTomorrow) as UTC Dates. */
  private async todayRange(): Promise<{ start: Date; end: Date; tz: string }> {
    const tenant = await this.db.tenant.findByPk(this.tenantId, { attributes: ['timezone'] });
    const tz = tenant?.timezone || 'UTC';
    const day = ymd(new Date(), tz);
    const start = wallClockToUtc(day, '00:00', tz);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    return { start, end, tz };
  }

  // ── Records ────────────────────────────────────────────────────────────────
  /** List attendance records (guardShifts) with ACL + attendance filters. */
  async list(query: any) {
    const filter: any = { ...(query.filter || query) };

    // Departamento filter (Settings › Departamentos): narrow every leg to the
    // department's members. Each leg keys people differently — guardShift by
    // securityGuard id, supervisor/staff shifts by USER id — so resolve both
    // here once. departmentMemberUserIds also travels to the folding queries.
    let departmentMemberUserIds: string[] | null = null;
    if (filter.departmentId) {
      const { Op } = this.db.Sequelize;
      const members = await this.db.tenantUser.findAll({
        where: { tenantId: this.tenantId, departmentId: filter.departmentId },
        attributes: ['userId'],
      });
      const memberIds = members.map((m: any) => String(m.userId)).filter(Boolean);
      departmentMemberUserIds = memberIds;
      const sgRows = memberIds.length
        ? await this.db.securityGuard.findAll({
            where: {
              tenantId: this.tenantId,
              guardId: { [Op.in]: memberIds },
            },
            attributes: ['id'],
          })
        : [];
      filter.guardNameIdIn = sgRows.map((g: any) => g.id);
      delete filter.departmentId;
    }

    const guardResult = await GuardShiftRepository.findAndCountAll(
      {
        filter,
        limit: query.limit,
        offset: query.offset,
        orderBy: query.orderBy,
      },
      this.options,
    );
    // Fold supervisor shifts (which live in supervisorShift, never guardShift)
    // into the SAME list, tagged role='supervisor'. Only for broad-access
    // (admin/unrestricted) viewers — supervisors have no post-site, so a
    // post-scoped viewer must not see them. Best-effort; never breaks the list.
    try {
      const acl = await this.payrollAclWhere();
      const isBroad = acl != null && Object.keys(acl).length === 0;
      if (!isBroad) return guardResult;
      const supRows = await this.listSupervisorShiftsForNomina(filter, departmentMemberUserIds);
      const staffRows = await this.listStaffShiftsForNomina(filter, departmentMemberUserIds);
      const extra = [...supRows, ...staffRows];
      if (!extra.length) return guardResult;
      const merged = [...((guardResult as any).rows || []), ...extra].sort(
        (a: any, b: any) => new Date(b.punchInTime || 0).getTime() - new Date(a.punchInTime || 0).getTime(),
      );
      const limit = Number(query.limit) || merged.length;
      return { rows: merged.slice(0, limit), count: ((guardResult as any).count || 0) + extra.length };
    } catch {
      return guardResult;
    }
  }

  /** Supervisor shifts normalized to the attendance-record shape (role='supervisor'). */
  private async listSupervisorShiftsForNomina(
    filter: any,
    departmentMemberUserIds: string[] | null = null,
  ): Promise<any[]> {
    const db = this.db;
    const tenantId = this.tenantId;
    const { Op } = db.Sequelize;
    const where: any = { tenantId };
    const range = filter?.punchInTimeRange;
    if (Array.isArray(range)) {
      const [start, end] = range;
      if (start) where.punchInTime = { ...(where.punchInTime || {}), [Op.gte]: new Date(start) };
      if (end) where.punchInTime = { ...(where.punchInTime || {}), [Op.lte]: new Date(end) };
    }
    if (filter?.status && filter.status !== 'all') where.status = filter.status;
    if (departmentMemberUserIds) {
      if (!departmentMemberUserIds.length) return [];
      where.supervisorUserId = { [Op.in]: departmentMemberUserIds };
    }
    const rows = await db.supervisorShift.findAll({ where, order: [['punchInTime', 'DESC']], limit: 1000 });
    if (!rows.length) return [];
    const uids = [...new Set(rows.map((r: any) => String(r.supervisorUserId)).filter(Boolean))];
    const users = await db.user.findAll({
      where: { id: { [Op.in]: uids } },
      attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
    });
    const nameById = new Map<string, string>(
      users.map((u: any): [string, string] => [
        String(u.id),
        String(u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Supervisor'),
      ]),
    );
    return rows.map((r: any) => this.normalizeSupervisorShift(r.get ? r.get({ plain: true }) : r, nameById));
  }

  /** Map a supervisorShift row → the guard attendance-record shape the CRM renders. */
  private normalizeSupervisorShift(s: any, nameById: Map<string, string>): any {
    return {
      id: s.id,
      role: 'supervisor',
      guardName: { id: s.supervisorUserId, fullName: nameById.get(String(s.supervisorUserId)) || 'Supervisor' },
      guardNameId: s.supervisorUserId,
      stationName: null,
      stationNameId: null,
      punchInTime: s.punchInTime,
      punchOutTime: s.punchOutTime,
      hoursWorked: s.hoursWorked != null ? Number(s.hoursWorked) : null,
      status: s.status,
      lateMinutes: s.lateMinutes,
      scheduledStart: s.scheduledStart,
      scheduledEnd: s.scheduledEnd,
      shiftSchedule: s.shiftKind,
      punchInLatitude: s.punchInLat != null ? Number(s.punchInLat) : null,
      punchInLongitude: s.punchInLng != null ? Number(s.punchInLng) : null,
      punchOutLatitude: s.punchOutLat != null ? Number(s.punchOutLat) : null,
      punchOutLongitude: s.punchOutLng != null ? Number(s.punchOutLng) : null,
      punchInPhoto: s.punchInPhoto,
      punchInAddress: s.punchInAddress,
      punchOutPhoto: s.punchOutPhoto,
      observations: s.observations,
      approvalStatus: null,
      numberOfPatrolsDuringShift: 0,
      numberOfIncidentsDurindShift: 0,
      patrolsDone: 0,
      dailyIncidents: 0,
    };
  }

  /** Staff (administrative/office) shifts normalized to the record shape (role='administrative'). */
  private async listStaffShiftsForNomina(
    filter: any,
    departmentMemberUserIds: string[] | null = null,
  ): Promise<any[]> {
    const db = this.db;
    const tenantId = this.tenantId;
    const { Op } = db.Sequelize;
    if (!db.staffShift) return [];
    const where: any = { tenantId };
    const range = filter?.punchInTimeRange;
    if (Array.isArray(range)) {
      const [start, end] = range;
      if (start) where.punchInTime = { ...(where.punchInTime || {}), [Op.gte]: new Date(start) };
      if (end) where.punchInTime = { ...(where.punchInTime || {}), [Op.lte]: new Date(end) };
    }
    if (filter?.status && filter.status !== 'all') where.status = filter.status;
    if (departmentMemberUserIds) {
      if (!departmentMemberUserIds.length) return [];
      where.userId = { [Op.in]: departmentMemberUserIds };
    }
    const rows = await db.staffShift.findAll({ where, order: [['punchInTime', 'DESC']], limit: 1000 });
    if (!rows.length) return [];
    const uids = [...new Set(rows.map((r: any) => String(r.userId)).filter(Boolean))];
    const users = await db.user.findAll({
      where: { id: { [Op.in]: uids } },
      attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
    });
    const nameById = new Map<string, string>(
      users.map((u: any): [string, string] => [
        String(u.id),
        String(u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Administrativo'),
      ]),
    );
    return rows.map((r: any) => this.normalizeStaffShift(r.get ? r.get({ plain: true }) : r, nameById));
  }

  /** Map a staffShift row → the attendance-record shape the CRM renders. */
  private normalizeStaffShift(s: any, nameById: Map<string, string>): any {
    return {
      id: s.id,
      role: 'administrative',
      guardName: { id: s.userId, fullName: nameById.get(String(s.userId)) || 'Administrativo' },
      guardNameId: s.userId,
      stationName: null,
      stationNameId: null,
      punchInTime: s.punchInTime,
      punchOutTime: s.punchOutTime,
      hoursWorked: s.hoursWorked != null ? Number(s.hoursWorked) : null,
      status: s.status,
      lateMinutes: s.lateMinutes,
      scheduledStart: null,
      scheduledEnd: null,
      shiftSchedule: null,
      punchInLatitude: s.punchInLat != null ? Number(s.punchInLat) : null,
      punchInLongitude: s.punchInLng != null ? Number(s.punchInLng) : null,
      punchOutLatitude: s.punchOutLat != null ? Number(s.punchOutLat) : null,
      punchOutLongitude: s.punchOutLng != null ? Number(s.punchOutLng) : null,
      punchInPhoto: s.punchInPhoto,
      punchInAddress: s.punchInAddress,
      punchOutPhoto: s.punchOutPhoto,
      observations: s.observations,
      punchInDistanceM: s.punchInDistanceM ?? null,
      punchInOutsideGeofence: s.punchInOutsideGeofence ?? null,
      approvalStatus: null,
      numberOfPatrolsDuringShift: 0,
      numberOfIncidentsDurindShift: 0,
      patrolsDone: 0,
      dailyIncidents: 0,
    };
  }

  async findById(id: string) {
    try {
      return await GuardShiftRepository.findById(id, this.options);
    } catch (e) {
      // Might be a supervisor OR staff shift (different tables) — resolve + normalize.
      const db = this.db;
      const supRow = await db.supervisorShift.findOne({ where: { id, tenantId: this.tenantId } });
      if (supRow) {
        const s = supRow.get ? supRow.get({ plain: true }) : supRow;
        const user = await db.user.findOne({
          where: { id: s.supervisorUserId },
          attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
        });
        const nameById = new Map<string, string>([
          [String(s.supervisorUserId), String((user && (user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email)) || 'Supervisor')],
        ]);
        return this.normalizeSupervisorShift(s, nameById);
      }
      const staffRow = db.staffShift ? await db.staffShift.findOne({ where: { id, tenantId: this.tenantId } }) : null;
      if (staffRow) {
        const s = staffRow.get ? staffRow.get({ plain: true }) : staffRow;
        const user = await db.user.findOne({
          where: { id: s.userId },
          attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
        });
        const nameById = new Map<string, string>([
          [String(s.userId), String((user && (user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email)) || 'Administrativo')],
        ]);
        return this.normalizeStaffShift(s, nameById);
      }
      throw e;
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────────────
  async dashboard(_query: any = {}) {
    const db = this.db;
    const tenantId = this.tenantId;
    const { start, end } = await this.todayRange();

    const [
      scheduledToday,
      clockedInNow,
      lateToday,
      noShowsToday,
      missedClockouts,
      overtimeToday,
      pendingRecordApprovals,
      pendingCorrections,
    ] = await Promise.all([
      db.shift.count({ where: { tenantId, startTime: { [Op.gte]: start, [Op.lt]: end } } }),
      db.guardShift.count({ where: { tenantId, punchOutTime: null } }),
      db.guardShift.count({ where: { tenantId, status: 'late', punchInTime: { [Op.gte]: start, [Op.lt]: end } } }),
      db.attendanceException.count({ where: { tenantId, type: 'no_call_no_show', detectedAt: { [Op.gte]: start, [Op.lt]: end } } }),
      db.attendanceException.count({ where: { tenantId, type: 'missed_clockout', status: 'open' } }),
      db.guardShift.count({ where: { tenantId, overtimeMinutes: { [Op.gt]: 0 }, punchInTime: { [Op.gte]: start, [Op.lt]: end } } }),
      db.guardShift.count({ where: { tenantId, approvalStatus: 'pending' } }),
      db.attendanceCorrection.count({ where: { tenantId, status: 'pending' } }),
    ]);

    const clockedInToday = await db.guardShift.count({
      where: { tenantId, punchInTime: { [Op.gte]: start, [Op.lt]: end } },
    });

    // Fold supervisors (supervisorShift) into the live/attendance counts so the
    // asistencia dashboard reflects them too — they never have a guardShift.
    let supClockedInNow = 0, supClockedInToday = 0, supLateToday = 0;
    try {
      [supClockedInNow, supClockedInToday, supLateToday] = await Promise.all([
        db.supervisorShift.count({ where: { tenantId, punchOutTime: null } }),
        db.supervisorShift.count({ where: { tenantId, punchInTime: { [Op.gte]: start, [Op.lt]: end } } }),
        db.supervisorShift.count({ where: { tenantId, status: 'late', punchInTime: { [Op.gte]: start, [Op.lt]: end } } }),
      ]);
    } catch { /* supervisors optional */ }

    // Fold administrative/office staff (staffShift) too — same rationale.
    let staffClockedInNow = 0, staffClockedInToday = 0;
    try {
      if (db.staffShift) {
        [staffClockedInNow, staffClockedInToday] = await Promise.all([
          db.staffShift.count({ where: { tenantId, punchOutTime: null } }),
          db.staffShift.count({ where: { tenantId, punchInTime: { [Op.gte]: start, [Op.lt]: end } } }),
        ]);
      }
    } catch { /* staff optional */ }

    // Attendance rate compares punches against the schedule. Only guards have a
    // schedule (db.shift), so the rate is guard-based (supervisors/staff have no
    // scheduled denominator). Clamp to 100% for extra/unscheduled guard punches.
    const attendancePct =
      scheduledToday > 0 ? Math.min(100, Math.round((clockedInToday / scheduledToday) * 100)) : null;

    return {
      scheduledToday,
      clockedInNow: clockedInNow + supClockedInNow + staffClockedInNow,
      lateToday: lateToday + supLateToday,
      noShowsToday,
      missedClockouts,
      overtimeToday,
      pendingApprovals: pendingRecordApprovals + pendingCorrections,
      attendancePct,
    };
  }

  // ── Exceptions ───────────────────────────────────────────────────────────────
  async listExceptions(query: any) {
    const db = this.db;
    const tenantId = this.tenantId;
    const filter = query.filter || query || {};
    const where: any = { tenantId };
    if (filter.type) where.type = filter.type;
    if (filter.severity) where.severity = filter.severity;
    if (filter.status) where.status = filter.status;
    if (filter.stationId) where.stationId = filter.stationId;

    const { rows, count } = await db.attendanceException.findAndCountAll({
      where,
      include: [
        { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'] },
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
        // Who resolved/acknowledged it — needed for the CRM history trail.
        { model: db.user, as: 'resolvedBy', attributes: ['id', 'firstName', 'lastName'] },
      ],
      order: [['detectedAt', 'DESC']],
      limit: query.limit ? Number(query.limit) : 50,
      offset: query.offset ? Number(query.offset) : 0,
    });
    return { rows, count };
  }

  async resolveException(id: string, data: { status?: string; resolutionNotes?: string }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const row = await db.attendanceException.findOne({ where: { id, tenantId } });
    if (!row) throw new Error404();
    const status = ['resolved', 'acknowledged', 'approved', 'rejected'].includes(data.status || '')
      ? data.status
      : 'resolved';
    await row.update({
      status,
      resolutionNotes: data.resolutionNotes ?? row.resolutionNotes,
      resolvedById: currentUser.id,
      resolvedAt: new Date(),
      updatedById: currentUser.id,
    });
    await this.audit('attendanceException', row.id, AuditLogRepository.UPDATE, row);
    return row;
  }

  // ── Approvals (on the record) ────────────────────────────────────────────────
  async approve(id: string, data: { notes?: string }) {
    return this.setApproval(id, 'approved', data?.notes);
  }
  async reject(id: string, data: { notes?: string }) {
    return this.setApproval(id, 'rejected', data?.notes);
  }

  private async setApproval(id: string, decision: 'approved' | 'rejected', notes?: string) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const record = await db.guardShift.findOne({ where: { id, tenantId } });
    if (!record) throw new Error404();
    await this.assertNotLocked(record);

    // Approval is orthogonal to the punch classification: record the decision on
    // `approvalStatus` ONLY and leave `status` (on_time / late / overtime /
    // pending_review) intact so the sheet and payroll keep the real punctuality
    // signal. (Previously this overwrote `status` with a flat 'approved'/'rejected',
    // destroying the classification the roster reads.)
    await record.update({
      approvalStatus: decision,
      approvedById: currentUser.id,
      approvedAt: new Date(),
      approvalNotes: notes ?? record.approvalNotes,
      updatedById: currentUser.id,
    });
    await this.audit('guardShift', record.id, AuditLogRepository.UPDATE, record);

    // Close any open exceptions tied to this record.
    await db.attendanceException.update(
      { status: decision === 'approved' ? 'approved' : 'rejected', resolvedById: currentUser.id, resolvedAt: new Date() },
      { where: { tenantId, guardShiftId: record.id, status: 'open' } },
    );

    // Notify the guard (SPECIFIC → recipientUserId resolved from securityGuard).
    try {
      const sg = await db.securityGuard.findByPk(record.guardNameId, { attributes: ['guardId', 'fullName'] });
      await dispatch(decision === 'approved' ? 'attendance.approved' : 'attendance.rejected', {
        guardName: sg?.fullName || 'Guardia',
        reason: notes || '',
      }, {
        database: db,
        tenantId,
        recipientUserId: sg?.guardId,
        sourceEntityType: 'guardShift',
        sourceEntityId: record.id,
      });
    } catch (e) {
      console.error('[attendance] approval notify failed:', (e as any)?.message || e);
    }

    return record;
  }

  // ── Early clock-out approval requests ────────────────────────────────────────
  /** List clock-out approval requests (default: pending), ACL not narrowed. */
  async listClockOutRequests(query: any = {}) {
    const db = this.db;
    const tenantId = this.tenantId;
    const where: any = { tenantId, deletedAt: null };
    const status = query.status || 'pending';
    if (status && status !== 'all') where.status = String(status).split(',');
    const rows = await db.clockOutRequest.findAll({
      where,
      include: [
        { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'] },
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
        {
          model: db.guardShift,
          as: 'guardShift',
          attributes: ['id', 'punchInTime', 'scheduledEnd'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(Number(query.limit) || 100, 200),
    });
    return { rows: rows.map((r: any) => r.get({ plain: true })), count: rows.length };
  }

  /** Approve/reject a clock-out request; notify the guard (in-app + email + push). */
  async decideClockOutRequest(
    id: string,
    data: { status: 'approved' | 'rejected'; notes?: string },
  ) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const decision = data?.status === 'approved' ? 'approved' : 'rejected';

    const reqRow = await db.clockOutRequest.findOne({
      where: { id, tenantId, deletedAt: null },
    });
    if (!reqRow) throw new Error404();
    // Only a pending request can be decided — re-deciding an already
    // approved/rejected/consumed row would re-notify the guard and could
    // resurrect a consumed approval.
    if (reqRow.status !== 'pending') {
      throw new Error400(this.options.language, 'attendance.requestAlreadyDecided');
    }

    await reqRow.update({
      status: decision,
      decidedById: currentUser.id,
      decidedAt: new Date(),
      decisionNotes: data?.notes ?? reqRow.decisionNotes,
      updatedById: currentUser.id,
    });
    await this.audit('clockOutRequest', reqRow.id, AuditLogRepository.UPDATE, reqRow);

    // Notify the requesting guard: in-app + email (dispatch) AND a push.
    try {
      const sg = reqRow.securityGuardId
        ? await db.securityGuard.findByPk(reqRow.securityGuardId, {
            attributes: ['fullName', 'guardId'],
          })
        : null;
      const station = reqRow.stationId
        ? await db.station.findByPk(reqRow.stationId, { attributes: ['stationName'] })
        : null;
      const event =
        decision === 'approved'
          ? 'attendance.clockout_approved'
          : 'attendance.clockout_rejected';
      const tData = {
        guardName: sg?.fullName || 'Guardia',
        stationName: station?.stationName || null,
        reason: data?.notes || null,
      };
      await dispatch(event, tData, {
        database: db,
        tenantId,
        recipientUserId: reqRow.guardId,
        sourceEntityType: 'clockOutRequest',
        sourceEntityId: reqRow.id,
      });
      await pushToUser(db, tenantId, reqRow.guardId, {
        title:
          decision === 'approved'
            ? '✅ Salida anticipada aprobada'
            : '❌ Salida anticipada rechazada',
        body:
          decision === 'approved'
            ? 'Ya puedes marcar tu salida.'
            : data?.notes
              ? `Rechazada: ${data.notes}`
              : 'Tu solicitud fue rechazada.',
        data: { type: event, clockOutRequestId: reqRow.id },
      });
    } catch (e) {
      console.error('[clockOutRequest] decision notify failed:', (e as any)?.message || e);
    }

    return reqRow.get({ plain: true });
  }

  // ── Late clock-in approval requests ──────────────────────────────────────────
  /** List clock-in approval requests (default: pending), ACL not narrowed. */
  async listClockInRequests(query: any = {}) {
    const db = this.db;
    const tenantId = this.tenantId;
    const where: any = { tenantId, deletedAt: null };
    const status = query.status || 'pending';
    if (status && status !== 'all') where.status = String(status).split(',');
    const rows = await db.clockInRequest.findAll({
      where,
      include: [
        { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'] },
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(Number(query.limit) || 100, 200),
    });
    return { rows: rows.map((r: any) => r.get({ plain: true })), count: rows.length };
  }

  /** Approve/reject a clock-in request; notify the guard (in-app + email + push). */
  async decideClockInRequest(
    id: string,
    data: { status: 'approved' | 'rejected'; notes?: string },
  ) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const decision = data?.status === 'approved' ? 'approved' : 'rejected';

    const reqRow = await db.clockInRequest.findOne({
      where: { id, tenantId, deletedAt: null },
    });
    if (!reqRow) throw new Error404();
    // Only a pending request can be decided (see decideClockOutRequest).
    if (reqRow.status !== 'pending') {
      throw new Error400(this.options.language, 'attendance.requestAlreadyDecided');
    }

    // On approval the late clock-in is allowed for the next 60 minutes only.
    const now = new Date();
    await reqRow.update({
      status: decision,
      approvedById: currentUser.id,
      approvedAt: now,
      decisionNotes: data?.notes ?? reqRow.decisionNotes,
      expiresAt: decision === 'approved' ? new Date(now.getTime() + 60 * 60 * 1000) : reqRow.expiresAt,
      updatedById: currentUser.id,
    });
    await this.audit('clockInRequest', reqRow.id, AuditLogRepository.UPDATE, reqRow);

    // Notify the requesting guard: in-app + email (dispatch) AND a push.
    try {
      const sg = reqRow.guardId
        ? await db.securityGuard.findByPk(reqRow.guardId, {
            attributes: ['fullName', 'guardId'],
          })
        : null;
      const station = reqRow.stationId
        ? await db.station.findByPk(reqRow.stationId, { attributes: ['stationName'] })
        : null;
      const event =
        decision === 'approved'
          ? 'attendance.clockin_approved'
          : 'attendance.clockin_rejected';
      const tData = {
        guardName: sg?.fullName || 'Guardia',
        stationName: station?.stationName || null,
        reason: data?.notes || null,
      };
      await dispatch(event, tData, {
        database: db,
        tenantId,
        recipientUserId: reqRow.guardUserId,
        sourceEntityType: 'clockInRequest',
        sourceEntityId: reqRow.id,
      });
      await pushToUser(db, tenantId, reqRow.guardUserId, {
        title:
          decision === 'approved'
            ? '✅ Entrada tarde aprobada'
            : '❌ Entrada tarde rechazada',
        body:
          decision === 'approved'
            ? 'Ya puedes marcar tu entrada.'
            : data?.notes
              ? `Rechazada: ${data.notes}`
              : 'Tu solicitud fue rechazada.',
        data: { type: event, clockInRequestId: reqRow.id },
      });
    } catch (e) {
      console.error('[clockInRequest] decision notify failed:', (e as any)?.message || e);
    }

    return reqRow.get({ plain: true });
  }

  // ── Manual corrections ───────────────────────────────────────────────────────
  /** Submit a correction request (original value preserved; applied on approve). */
  async correct(guardShiftId: string, data: { field: string; correctedValue: any; reason: string }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);

    if (!data?.field || !data?.reason) {
      throw new Error400(this.options.language, 'errors.validation.message');
    }
    const ALLOWED = ['punchInTime', 'punchOutTime', 'status', 'observations'];
    if (!ALLOWED.includes(data.field)) {
      throw new Error400(this.options.language, 'errors.validation.message');
    }

    const record = await db.guardShift.findOne({ where: { id: guardShiftId, tenantId } });
    if (!record) throw new Error404();
    await this.assertNotLocked(record);

    const original = record.get(data.field);
    const correction = await db.attendanceCorrection.create({
      field: data.field,
      originalValue: original == null ? null : String(original),
      correctedValue: data.correctedValue == null ? null : String(data.correctedValue),
      reason: data.reason,
      status: 'pending',
      guardShiftId: record.id,
      requestedById: currentUser.id,
      tenantId,
      createdById: currentUser.id,
      updatedById: currentUser.id,
    });
    await this.audit('attendanceCorrection', correction.id, AuditLogRepository.CREATE, correction);

    // Flag the record + raise an exception for the approvals queue.
    await record.update({ approvalStatus: 'pending', updatedById: currentUser.id });
    try {
      const sg = await db.securityGuard.findByPk(record.guardNameId, { attributes: ['fullName'] });
      await dispatch('attendance.correction_submitted', {
        guardName: sg?.fullName || 'Guardia',
        field: data.field,
        reason: data.reason,
      }, { database: db, tenantId, sourceEntityType: 'attendanceCorrection', sourceEntityId: correction.id });
    } catch (e) {
      console.error('[attendance] correction notify failed:', (e as any)?.message || e);
    }
    return correction;
  }

  async listCorrections(query: any) {
    const db = this.db;
    const tenantId = this.tenantId;
    const where: any = { tenantId };
    if ((query.filter || query)?.status) where.status = (query.filter || query).status;
    const { rows, count } = await db.attendanceCorrection.findAndCountAll({
      where,
      include: [{ model: db.guardShift, as: 'guardShift', attributes: ['id', 'guardNameId', 'stationNameId'] }],
      order: [['createdAt', 'DESC']],
      limit: query.limit ? Number(query.limit) : 50,
      offset: query.offset ? Number(query.offset) : 0,
    });
    return { rows, count };
  }

  /** Approve a correction → apply the corrected value to the guardShift. */
  async applyCorrection(correctionId: string, data: { decision: 'approved' | 'rejected'; notes?: string }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const correction = await db.attendanceCorrection.findOne({ where: { id: correctionId, tenantId } });
    if (!correction) throw new Error404();
    if (correction.status !== 'pending') {
      throw new Error400(this.options.language, 'errors.validation.message');
    }

    const decision = data.decision === 'rejected' ? 'rejected' : 'approved';
    if (decision === 'approved') {
      const record = await db.guardShift.findOne({ where: { id: correction.guardShiftId, tenantId } });
      if (record) {
        await this.assertNotLocked(record);
        const field = correction.field;
        let value: any = correction.correctedValue;
        if ((field === 'punchInTime' || field === 'punchOutTime') && value) value = new Date(value);
        await record.update({ [field]: value, updatedById: currentUser.id });
        await this.audit('guardShift', record.id, AuditLogRepository.UPDATE, record);
      }
      await correction.update({ status: 'applied', approvedById: currentUser.id, approvedAt: new Date(), approvalNotes: data.notes ?? null, updatedById: currentUser.id });
    } else {
      await correction.update({ status: 'rejected', approvedById: currentUser.id, approvedAt: new Date(), approvalNotes: data.notes ?? null, updatedById: currentUser.id });
    }
    await this.audit('attendanceCorrection', correction.id, AuditLogRepository.UPDATE, correction);
    return correction;
  }

  // ── Settings ─────────────────────────────────────────────────────────────────
  async getSettings() {
    return getNominaSettings(this.db, this.tenantId);
  }

  async saveSettings(data: any) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const merged = mergeNominaSettings(data);
    const [row] = await db.settings.findOrCreate({
      where: { id: tenantId },
      defaults: { id: tenantId, theme: 'light', tenantId },
    });
    await row.update({ nominaSettings: merged, updatedById: currentUser.id });
    await this.audit('settings', tenantId, AuditLogRepository.UPDATE, { nominaSettings: merged });
    return merged;
  }

  /** Merge per-guard hourly-rate overrides into settings (keyed by guard id). */
  async saveGuardRates(data: { rates: Record<string, number> }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const current = await getNominaSettings(db, tenantId);
    const rates = { ...(current.payroll.guardRates || {}) };
    for (const [k, v] of Object.entries(data?.rates || {})) {
      const n = Number(v);
      if (!isNaN(n) && n > 0) rates[k] = n;
      else delete rates[k]; // 0 / invalid clears the override
    }
    const merged = mergeNominaSettings({ ...current, payroll: { ...current.payroll, guardRates: rates } });
    const [row] = await db.settings.findOrCreate({
      where: { id: tenantId },
      defaults: { id: tenantId, theme: 'light', tenantId },
    });
    await row.update({ nominaSettings: merged, updatedById: currentUser.id });
    await this.audit('settings', tenantId, AuditLogRepository.UPDATE, { guardRates: rates });
    return merged.payroll.guardRates;
  }

  // ── Payroll summary ─────────────────────────────────────────────────────────
  /**
   * Payroll-ready per-guard aggregate over a date range. Reuses
   * GuardShiftRepository's ACL (supervisors see only assigned post-sites). Does
   * NOT compute pay — only hours/counts. Range defaults to the last 14 days.
   */
  async payrollSummary(query: any) {
    const db = this.db;
    const tenantId = this.tenantId;
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 14 * 24 * 3600 * 1000);

    // LEAN payroll fetch. The old path called GuardShiftRepository.findAndCountAll
    // with limit:100000, which (a) SELECT *'d full guardShift rows incl. the base64
    // punch-photo blobs and full station/securityGuard includes, and (b) ran a 2N
    // per-row enrich (getPatrolsDone + getDailyIncidents) the summary never reads.
    // Here we run ONE query with only the scalars the aggregation consumes
    // (hoursWorked, overtimeMinutes, status, lateMinutes, id, guardNameId) plus a
    // scoped guardName include, while preserving the same post-site ACL the list
    // applies for non-admins.
    const aclWhere = await this.payrollAclWhere();
    if (aclWhere === null) {
      // Non-admin with no accessible post-sites — same empty result the list returns.
      const settingsEmpty = await getNominaSettings(db, tenantId);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        rows: [],
        totals: { shifts: 0, regularHours: 0, overtimeHours: 0, totalHours: 0, lateCount: 0, noShows: 0, grossPay: null },
        currency: settingsEmpty.payroll.currency,
        ratesEnabled: false,
      };
    }

    const rows = (await db.guardShift.findAll({
      where: {
        tenantId,
        punchInTime: { [Op.gte]: from, [Op.lte]: to },
        ...aclWhere,
      },
      attributes: ['id', 'guardNameId', 'hoursWorked', 'overtimeMinutes', 'status', 'lateMinutes', 'punchInTime'],
      include: [
        { model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'] },
      ],
      order: [['punchInTime', 'ASC']],
    })).map((r: any) => r.get({ plain: true }));

    type Agg = {
      guardId: string;
      guardName: string;
      shifts: number;
      regularHours: number;
      overtimeHours: number;
      totalHours: number;
      lateCount: number;
      missedClockouts: number;
      noShows: number;
      approvedCorrections: number;
      payableHours: number;
    };
    const byGuard = new Map<string, Agg>();
    const daysByGuard = new Map<string, Set<string>>(); // distinct punch-in days/guard
    const shiftIds: string[] = [];

    for (const r of rows as any[]) {
      const gid = r.guardName?.id || r.guardNameId || 'unknown';
      shiftIds.push(r.id);
      if (r.punchInTime) {
        const dayKey = new Date(r.punchInTime).toISOString().slice(0, 10);
        let ds = daysByGuard.get(gid);
        if (!ds) { ds = new Set(); daysByGuard.set(gid, ds); }
        ds.add(dayKey);
      }
      const a =
        byGuard.get(gid) ||
        {
          guardId: gid,
          guardName: r.guardName?.fullName || '—',
          shifts: 0,
          regularHours: 0,
          overtimeHours: 0,
          totalHours: 0,
          lateCount: 0,
          missedClockouts: 0,
          noShows: 0,
          approvedCorrections: 0,
          payableHours: 0,
        };
      const total = Number(r.hoursWorked || 0);
      const ot = Number(r.overtimeMinutes || 0) / 60;
      a.shifts += 1;
      a.totalHours += total;
      a.overtimeHours += ot;
      a.regularHours += Math.max(0, total - ot);
      if (r.status === 'late' || Number(r.lateMinutes || 0) > 0) a.lateCount += 1;
      if (r.status === 'missed_clockout') a.missedClockouts += 1;
      byGuard.set(gid, a);
    }

    // No-shows (no punch → only in the exception table), keyed by securityGuard id.
    try {
      const Sequelize = db.Sequelize;
      const noShows = await db.attendanceException.findAll({
        where: { tenantId, type: 'no_call_no_show', detectedAt: { [Op.between]: [from, to] } },
        attributes: ['guardId', [Sequelize.fn('COUNT', Sequelize.col('id')), 'c']],
        group: ['guardId'],
        raw: true,
      });
      for (const ns of noShows as any[]) {
        const a = byGuard.get(ns.guardId);
        if (a) a.noShows = Number(ns.c || 0);
      }
    } catch { /* best-effort */ }

    // Applied corrections in range, mapped to their guard via the punch.
    try {
      if (shiftIds.length) {
        const idToGuard = new Map<string, string>();
        for (const r of rows as any[]) idToGuard.set(r.id, r.guardName?.id || r.guardNameId);
        const corr = await db.attendanceCorrection.findAll({
          where: { tenantId, status: 'applied', guardShiftId: { [Op.in]: shiftIds } },
          attributes: ['guardShiftId'],
          raw: true,
        });
        for (const c of corr as any[]) {
          const gid = idToGuard.get(c.guardShiftId);
          const a = gid && byGuard.get(gid);
          if (a) a.approvedCorrections += 1;
        }
      }
    } catch { /* best-effort */ }

    // Supervisors live in supervisorShift (never a securityGuard row), so they'd
    // otherwise be invisible in nómina. Fold their shifts into the same aggregation,
    // keyed by userId (prefixed) and tagged role='supervisor'.
    const supervisorIds = new Set<string>();
    try {
      const supRows = await db.supervisorShift.findAll({
        where: { tenantId, punchInTime: { [Op.gte]: from, [Op.lte]: to } },
        attributes: ['id', 'supervisorUserId', 'hoursWorked', 'status', 'lateMinutes', 'punchInTime'],
        order: [['punchInTime', 'ASC']],
      });
      if (supRows.length) {
        const uids = [...new Set(supRows.map((r: any) => String(r.supervisorUserId)).filter(Boolean))];
        const users = await db.user.findAll({
          where: { id: { [Op.in]: uids } },
          attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
        });
        const nameById = new Map<string, string>(users.map((u: any): [string, string] => [
          String(u.id),
          String(u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Supervisor'),
        ]));
        for (const r of supRows as any[]) {
          const s = r.get ? r.get({ plain: true }) : r;
          const gid = 'sup:' + String(s.supervisorUserId);
          supervisorIds.add(gid);
          if (s.punchInTime) {
            const dayKey = new Date(s.punchInTime).toISOString().slice(0, 10);
            let ds = daysByGuard.get(gid);
            if (!ds) { ds = new Set(); daysByGuard.set(gid, ds); }
            ds.add(dayKey);
          }
          const a = byGuard.get(gid) || {
            guardId: gid, guardName: nameById.get(String(s.supervisorUserId)) || 'Supervisor',
            shifts: 0, regularHours: 0, overtimeHours: 0, totalHours: 0,
            lateCount: 0, missedClockouts: 0, noShows: 0, approvedCorrections: 0, payableHours: 0,
          };
          const total = Number(s.hoursWorked || 0);
          a.shifts += 1;
          a.totalHours += total;
          a.regularHours += total; // supervisor shifts have no OT tracking
          if (s.status === 'late' || Number(s.lateMinutes || 0) > 0) a.lateCount += 1;
          byGuard.set(gid, a);
        }
      }
    } catch { /* supervisors optional */ }

    // Administrative/office staff live in staffShift — fold identically, keyed
    // 'stf:' and tagged role='administrative', so their hours reach payroll too.
    try {
      if (db.staffShift) {
        const staffRows = await db.staffShift.findAll({
          where: { tenantId, punchInTime: { [Op.gte]: from, [Op.lte]: to } },
          attributes: ['id', 'userId', 'hoursWorked', 'status', 'lateMinutes', 'punchInTime'],
          order: [['punchInTime', 'ASC']],
        });
        if (staffRows.length) {
          const uids = [...new Set(staffRows.map((r: any) => String(r.userId)).filter(Boolean))];
          const users = await db.user.findAll({
            where: { id: { [Op.in]: uids } },
            attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'],
          });
          const nameById = new Map<string, string>(users.map((u: any): [string, string] => [
            String(u.id),
            String(u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Administrativo'),
          ]));
          for (const r of staffRows as any[]) {
            const s = r.get ? r.get({ plain: true }) : r;
            const gid = 'stf:' + String(s.userId);
            if (s.punchInTime) {
              const dayKey = new Date(s.punchInTime).toISOString().slice(0, 10);
              let ds = daysByGuard.get(gid);
              if (!ds) { ds = new Set(); daysByGuard.set(gid, ds); }
              ds.add(dayKey);
            }
            const a = byGuard.get(gid) || {
              guardId: gid, guardName: nameById.get(String(s.userId)) || 'Administrativo',
              shifts: 0, regularHours: 0, overtimeHours: 0, totalHours: 0,
              lateCount: 0, missedClockouts: 0, noShows: 0, approvedCorrections: 0, payableHours: 0,
            };
            const total = Number(s.hoursWorked || 0);
            a.shifts += 1;
            a.totalHours += total;
            a.regularHours += total;
            if (s.status === 'late' || Number(s.lateMinutes || 0) > 0) a.lateCount += 1;
            byGuard.set(gid, a);
          }
        }
      }
    } catch { /* staff optional */ }

    // Optional pay calculation — uses a per-guard rate override when present,
    // else the tenant default. Computed only when an effective rate > 0 exists.
    const settings = await getNominaSettings(db, tenantId);
    const defaultRate = Number(settings.payroll.defaultHourlyRate || 0);
    const otMult = Number(settings.payroll.overtimeMultiplier || 1.5);
    const guardRates = settings.payroll.guardRates || {};
    const rateFor = (gid: string) => {
      const r = Number(guardRates[gid]);
      return r > 0 ? r : defaultRate;
    };
    // Universal salary model: 'monthly' pays a fixed salary per guard; 'hourly' is the
    // legacy hours×rate. (Country labor rules for unworked days are configured in
    // settings.payroll.unworkedDayPolicy; reported here as days worked for the period.)
    const salaryBasis = (settings.payroll as any).salaryBasis === 'monthly' ? 'monthly' : 'hourly';
    const defaultMonthly = Number((settings.payroll as any).defaultMonthlySalary || 0);
    const guardMonthly: Record<string, number> = (settings.payroll as any).guardMonthlySalaries || {};
    const monthlyFor = (gid: string) => {
      const m = Number(guardMonthly[gid]);
      return m > 0 ? m : defaultMonthly;
    };
    const ratesEnabled = salaryBasis === 'monthly'
      ? (defaultMonthly > 0 || Object.values(guardMonthly).some((m) => Number(m) > 0))
      : (defaultRate > 0 || Object.values(guardRates).some((r) => Number(r) > 0));

    const round = (n: number) => Math.round(n * 100) / 100;
    const result = Array.from(byGuard.values()).map((a) => {
      const regularHours = round(a.regularHours);
      const overtimeHours = round(a.overtimeHours);
      const totalHours = round(a.totalHours);
      const daysWorked = daysByGuard.get(a.guardId)?.size || 0;
      const rate = rateFor(a.guardId);
      const monthlySalary = monthlyFor(a.guardId);
      const grossPay = salaryBasis === 'monthly'
        ? (monthlySalary > 0 ? round(monthlySalary) : null)
        : (rate > 0 ? round(regularHours * rate + overtimeHours * rate * otMult) : null);
      return {
        ...a,
        role: a.guardId.startsWith('sup:')
          ? 'supervisor'
          : a.guardId.startsWith('stf:')
            ? 'administrative'
            : 'guard',
        regularHours,
        overtimeHours,
        totalHours,
        daysWorked,
        payableHours: totalHours, // approved hours
        hourlyRate: rate || null,
        monthlySalary: salaryBasis === 'monthly' ? (monthlySalary || null) : null,
        grossPay,
      };
    });
    result.sort((x, y) => x.guardName.localeCompare(y.guardName));

    const totals = result.reduce(
      (t, a) => ({
        shifts: t.shifts + a.shifts,
        regularHours: round(t.regularHours + a.regularHours),
        overtimeHours: round(t.overtimeHours + a.overtimeHours),
        totalHours: round(t.totalHours + a.totalHours),
        lateCount: t.lateCount + a.lateCount,
        noShows: t.noShows + a.noShows,
      }),
      { shifts: 0, regularHours: 0, overtimeHours: 0, totalHours: 0, lateCount: 0, noShows: 0 },
    );

    const grossPayTotal = ratesEnabled
      ? round(result.reduce((sum, r) => sum + (r.grossPay || 0), 0))
      : null;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rows: result,
      totals: { ...totals, grossPay: grossPayTotal },
      currency: settings.payroll.currency,
      ratesEnabled,
      salaryBasis,
      extraHourTypes: (settings.payroll as any).extraHourTypes || [],
    };
  }

  /**
   * Close (lock) a payroll period: mark every record with punchInTime <= cutoff
   * as locked (read-only). Records edits/corrections/approvals are then rejected
   * while `lockAfterPayrollClose` is on. Audited; stores the cutoff in settings.
   */
  async closePeriod(data: { cutoff?: string }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const cutoff = data?.cutoff ? new Date(data.cutoff) : new Date();

    const [locked] = await db.guardShift.update(
      { locked: true, lockedAt: new Date(), updatedById: currentUser.id },
      { where: { tenantId, locked: false, punchInTime: { [Op.lte]: cutoff } } },
    );

    // Persist the cutoff in settings (payroll.lastPeriodClose).
    try {
      const current = await getNominaSettings(db, tenantId);
      const merged = mergeNominaSettings({
        ...current,
        payroll: { ...current.payroll, lastPeriodClose: cutoff.toISOString() },
      });
      const [row] = await db.settings.findOrCreate({
        where: { id: tenantId },
        defaults: { id: tenantId, theme: 'light', tenantId },
      });
      await row.update({ nominaSettings: merged, updatedById: currentUser.id });
    } catch (e) {
      console.error('[attendance] closePeriod settings update failed:', (e as any)?.message || e);
    }

    await this.audit('guardShift', `period:${cutoff.toISOString()}`, AuditLogRepository.UPDATE, {
      action: 'close_period',
      cutoff: cutoff.toISOString(),
      lockedCount: locked,
    });
    return { lockedCount: locked, cutoff: cutoff.toISOString() };
  }

  /**
   * Post-site ACL for the lean payroll query. Mirrors the non-admin restriction
   * in GuardShiftRepository.findAndCountAll exactly:
   *   - admin                       → {} (no postSite restriction)
   *   - non-admin w/ assigned posts → { postSiteId: { [Op.in]: ids } }
   *   - non-admin (customer) w/ a clientAccountId → that client's post-sites
   *   - non-admin with no accessible posts → null  (caller returns empty)
   */
  private async payrollAclWhere(): Promise<Record<string, any> | null> {
    const db = this.db;
    const tenantId = this.tenantId;
    try {
      const currentUser = SequelizeRepository.getCurrentUser(this.options);
      let isAdmin = false;
      if (currentUser && (currentUser as any).tenants) {
        const tenantUserRec = (currentUser as any).tenants.find(
          (t: any) => t.tenant.id === tenantId && t.status === 'active',
        );
        if (tenantUserRec) {
          let roles: any = [];
          if (Array.isArray(tenantUserRec.roles)) roles = tenantUserRec.roles;
          else if (typeof tenantUserRec.roles === 'string') {
            try { roles = JSON.parse(tenantUserRec.roles); } catch (e) { roles = []; }
          }
          isAdmin = roles.includes((await import('../security/roles')).default.values.admin);
        }
      }
      if (isAdmin) return {};

      const tenantUser = await db.tenantUser.findOne({
        where: { tenantId, userId: currentUser.id },
        include: [{ model: db.businessInfo, as: 'assignedPostSites', attributes: ['id'] }],
      });
      let allowedIds: any[] =
        (tenantUser && tenantUser.assignedPostSites && tenantUser.assignedPostSites.map((c: any) => c.id)) || [];

      if (!allowedIds.length) {
        const clientAccountId = currentUser && (currentUser as any).clientAccountId;
        if (clientAccountId) {
          const posts = await db.businessInfo.findAll({
            where: { tenantId, clientAccountId },
            attributes: ['id'],
          });
          allowedIds = (posts || []).map((p: any) => p.id).filter(Boolean);
        }
      }

      if (!allowedIds.length) return null;
      return { postSiteId: { [Op.in]: allowedIds } };
    } catch (e) {
      // On any ACL resolution error, fail closed to the prior behavior: the list
      // path swallows errors and proceeds unrestricted, so match that (no filter).
      return {};
    }
  }

  /** Throw if the record is payroll-locked (and locking is enforced). */
  private async assertNotLocked(record: any) {
    if (!record?.locked) return;
    const settings = await getNominaSettings(this.db, this.tenantId);
    if (settings.approval.lockAfterPayrollClose) {
      throw new Error400(this.options.language, 'entities.attendance.errors.locked');
    }
  }

  private async audit(entityName: string, entityId: string, action: string, record: any) {
    try {
      await AuditLogRepository.log(
        {
          entityName,
          entityId,
          action,
          values: record?.get ? record.get({ plain: true }) : record,
        },
        this.options,
      );
    } catch (e) {
      console.error('[attendance] audit failed:', (e as any)?.message || e);
    }
  }
}
