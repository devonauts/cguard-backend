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
    return GuardShiftRepository.findAndCountAll(
      {
        filter: query.filter || query,
        limit: query.limit,
        offset: query.offset,
        orderBy: query.orderBy,
      },
      this.options,
    );
  }

  async findById(id: string) {
    return GuardShiftRepository.findById(id, this.options);
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
    const attendancePct =
      scheduledToday > 0 ? Math.round((clockedInToday / scheduledToday) * 100) : null;

    return {
      scheduledToday,
      clockedInNow,
      lateToday,
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

    await record.update({
      approvalStatus: decision,
      status: decision === 'approved' ? 'approved' : 'rejected',
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

    // ACL-scoped punches in range.
    const { rows } = await GuardShiftRepository.findAndCountAll(
      { filter: { punchInTimeRange: [from.toISOString(), to.toISOString()] }, limit: 100000, offset: 0 },
      this.options,
    );

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
    const shiftIds: string[] = [];

    for (const r of rows as any[]) {
      const gid = r.guardName?.id || r.guardNameId || 'unknown';
      shiftIds.push(r.id);
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

    // Optional pay calculation — only when a rate is configured.
    const settings = await getNominaSettings(db, tenantId);
    const rate = Number(settings.payroll.defaultHourlyRate || 0);
    const otMult = Number(settings.payroll.overtimeMultiplier || 1.5);
    const ratesEnabled = rate > 0;

    const round = (n: number) => Math.round(n * 100) / 100;
    const result = Array.from(byGuard.values()).map((a) => {
      const regularHours = round(a.regularHours);
      const overtimeHours = round(a.overtimeHours);
      const totalHours = round(a.totalHours);
      return {
        ...a,
        regularHours,
        overtimeHours,
        totalHours,
        payableHours: totalHours, // approved hours
        grossPay: ratesEnabled
          ? round(regularHours * rate + overtimeHours * rate * otMult)
          : null,
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
