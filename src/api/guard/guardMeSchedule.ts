/**
 * GET /api/tenant/:tenantId/guard/me/schedule
 * 
 * Returns the guard's upcoming shifts and free days (approved time-off).
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';
import { timeLabelInTz } from '../../lib/tenantTime';
// Reuse the SAME rotation functions the shift generator (and the Programador's
// math) use — one source of truth for día/noche/libre, so the app just displays.
import { getRotationStatus, shiftHalfByStart } from '../../services/shiftGenerationService';

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

    // ─── AUTHORITATIVE DAY-BY-DAY SCHEDULE ──────────────────────────────────
    // The backend is the SINGLE source of truth: compute each day's code
    // (D/N/L, or a novedad) with the SAME functions the generator + Programador
    // use — getRotationStatus + shiftHalfByStart — so the app just paints this
    // and can never diverge. Covers the whole window (incl. past days the
    // generator hasn't materialised as shift rows).
    const pad = (n: number) => String(n).padStart(2, '0');
    const localYmd = (d: Date): string => {
      try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
      catch { return d.toISOString().slice(0, 10); }
    };
    const dseOf = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2024, 0, 1)) / 86400000);

    const asg = await db.guardAssignment.findOne({
      where: { guardId: userId, tenantId, status: 'active', deletedAt: null },
      attributes: ['id', 'stationId', 'positionId', 'platoonOffset', 'startDate', 'endDate', 'rotationStyleId'],
      order: [['createdAt', 'DESC']],
    });
    let rot: any = null, station: any = null, position: any = null;
    if (asg) {
      station = await db.station.findByPk(asg.stationId, { attributes: ['scheduleType', 'rotationStyleId'] });
      const rotId = (station && station.rotationStyleId) || asg.rotationStyleId;
      rot = rotId ? await db.rotationStyle.findByPk(rotId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] }) : null;
      position = asg.positionId ? await db.stationPosition.findByPk(asg.positionId, { attributes: ['startTime'] }) : null;
    }

    const startYmd = localYmd(rangeStart);
    const endYmd = localYmd(rangeEnd);

    // Novedades (overrides) take precedence over the rotation — same as Programador.
    const overrideByDate: Record<string, string> = {};
    try {
      const ovs = await db.scheduleOverride.findAll({
        where: { guardId: userId, tenantId, date: { [Op.between]: [startYmd, endYmd] } },
        attributes: ['date', 'type'],
      });
      for (const o of ovs) overrideByDate[String((o as any).date).slice(0, 10)] = (o as any).type;
    } catch { /* overrides optional */ }
    const timeOffByDate: Record<string, string> = {};
    for (const to of timeOff) {
      const c = new Date(to.startDate); const e = new Date(to.endDate);
      while (c <= e) { timeOffByDate[c.toISOString().slice(0, 10)] = to.type || 'V'; c.setDate(c.getDate() + 1); }
    }

    const dayCode = (status: 'day' | 'night' | 'rest'): string => {
      if (status === 'rest') return 'L';
      const st = station && station.scheduleType;
      if (st === '24h') return status === 'night' ? 'N' : 'D';
      if (st === '12h-night') return 'N';
      if (st === '12h-day') return 'D';
      return shiftHalfByStart(position && position.startTime) === 'night' ? 'N' : 'D'; // custom → by block hour
    };

    const days: { date: string; code: string }[] = [];
    let cur = new Date(`${startYmd}T12:00:00Z`);
    const endCur = new Date(`${endYmd}T12:00:00Z`);
    let guardCnt = 0;
    while (cur <= endCur && guardCnt < 400) {
      guardCnt++;
      const y = cur.getUTCFullYear(), m = cur.getUTCMonth() + 1, d = cur.getUTCDate();
      const ds = `${y}-${pad(m)}-${pad(d)}`;
      let code = '';
      if (overrideByDate[ds]) code = overrideByDate[ds];
      else if (timeOffByDate[ds]) code = timeOffByDate[ds];
      else if (asg && rot) {
        const sd = asg.startDate ? String(asg.startDate).slice(0, 10) : null;
        const ed = asg.endDate ? String(asg.endDate).slice(0, 10) : null;
        if ((sd && ds < sd) || (ed && ds > ed)) code = '';
        else code = dayCode(getRotationStatus(dseOf(y, m, d), asg.platoonOffset || 0, rot.dayShifts, rot.nightShifts, rot.restDays));
      }
      days.push({ date: ds, code });
      cur = new Date(cur.getTime() + 86400000);
    }

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
      // Authoritative per-day schedule — the app should render THIS directly.
      days,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
