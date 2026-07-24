/**
 * GET /api/tenant/:tenantId/guard/me/schedule
 * 
 * Returns the guard's upcoming shifts and free days (approved time-off).
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';
import { timeLabelInTz } from '../../lib/tenantTime';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Window: default = next 30 days; ?from=&to= (ISO) for calendar navigation.
    const now = new Date();
    const parseDate = (v: any) => { const d = v ? new Date(String(v)) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
    const rangeStart = parseDate(req.query?.from) || now;
    const rangeEnd = parseDate(req.query?.to) || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Belt-and-suspenders: never show a turno that belongs to an assignment the
    // guard no longer holds (ended / removed). Their future shifts SHOULD be
    // pruned when the assignment ends, but a legacy row (ended before pruning
    // existed) or any future path that forgets to prune would otherwise leave the
    // app showing phantom turnos — out of sync with Programador › Horario, which
    // computes live from the ACTIVE assignment. Exclude shifts whose parent
    // assignment is ended/soft-deleted; ad-hoc shifts (no assignment) are kept.
    const deadAssignments = await db.guardAssignment.findAll({
      where: {
        guardId: userId,
        tenantId,
        [Op.or]: [{ deletedAt: { [Op.ne]: null } }, { status: 'ended' }],
      },
      attributes: ['id'],
      paranoid: false,
    });
    const deadIds = deadAssignments.map((a: any) => a.id).filter(Boolean);

    const shifts = await db.shift.findAll({
      where: {
        guardId: userId,
        tenantId,
        startTime: { [Op.lte]: rangeEnd },
        endTime: { [Op.gte]: rangeStart },
        ...(deadIds.length
          ? { [Op.or]: [{ guardAssignmentId: null }, { guardAssignmentId: { [Op.notIn]: deadIds } }] }
          : {}),
      },
      attributes: ['id', 'startTime', 'endTime', 'stationId', 'postSiteId'],
      include: [
        // nickname (call-sign) + coordinates so the app's shift detail can show
        // the post and offer a "Cómo llegar" (navigate) action.
        { model: db.station, as: 'station', attributes: ['id', 'stationName', 'nickname', 'latitud', 'longitud'] },
      ],
      order: [['startTime', 'ASC']],
      limit: 100,
    });

    // Approved time-off (free days)
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    let timeOff: any[] = [];
    if (securityGuard) {
      const rows = await db.timeOffRequest.findAll({
        where: {
          guardId: securityGuard.id,
          tenantId,
          status: 'approved',
          endDate: { [Op.gte]: rangeStart },
          startDate: { [Op.lte]: rangeEnd },
        },
        attributes: ['id', 'startDate', 'endDate', 'type', 'reason', 'status'],
        order: [['startDate', 'ASC']],
        limit: 50,
      });
      timeOff = rows.map((r: any) => r.get({ plain: true }));
    }

    // Build free-day set from approved time-off ranges
    const freeDays: string[] = [];
    for (const to of timeOff) {
      const start = new Date(to.startDate);
      const end = new Date(to.endDate);
      const cursor = new Date(start);
      while (cursor <= end && freeDays.length < 365) {
        freeDays.push(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Tenant timezone is the single source of truth for displaying shift times.
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = (tenant && tenant.timezone) || 'UTC';

    return ApiResponseHandler.success(req, res, {
      timezone: tz,
      shifts: shifts.map((s: any) => {
        const p = s.get({ plain: true });
        return {
          ...p,
          startTimeLabel: timeLabelInTz(p.startTime, tz),
          endTimeLabel: timeLabelInTz(p.endTime, tz),
        };
      }),
      timeOff,
      freeDays: [...new Set(freeDays)],
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
