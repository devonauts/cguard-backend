import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';

/**
 * Schedule ("Horario") grid for a client's stations, scoped to one sede. Mirrors
 * Programador › Horario: rows = station positions (fijo/sacafranco) with their
 * assigned guard, columns = days. CRUD (change/assign guard) reuses the existing
 * /guard-assignment endpoints from the frontend.
 *
 * Cells are painted from the REAL generated `shift` rows — the exact same table
 * Programador › Horario reads (`/scheduler/overview`) — not from a re-derived
 * rotation formula. The old formula recomputed D/N/L from the station's
 * rotationStyle and, when a station had no rotationStyleId, fell back to
 * 'rest' for EVERY day. That painted a full-of-turnos sede as an empty wall of
 * L, contradicting Programador. Shifts are generated a year ahead
 * (shiftGenerationService.GENERATION_DAYS), so they are the source of truth for
 * any window this grid can show; rotation math survives only as the fallback
 * that marks a scheduled-but-off day as 'rest'.
 */

// Fixed rotation epoch — must match shiftGenerationService.ROTATION_EPOCH.
const ROTATION_EPOCH = Date.UTC(2024, 0, 1);
const dseOf = (d: Date) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ROTATION_EPOCH) / 86400000);
const rotationStatus = (dse: number, platoonOffset: number, dayShifts: number, nightShifts: number, restDays: number): 'day' | 'night' | 'rest' => {
  const cycle = Math.max(1, dayShifts + nightShifts + restDays);
  const a = (((dse - platoonOffset) % cycle) + cycle) % cycle;
  if (a < dayShifts) return 'day';
  if (a < dayShifts + nightShifts) return 'night';
  return 'rest';
};
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

// A shift's calendar day + clock time must be read in the TENANT's timezone —
// a 19:00-07:00 turno in Guayaquil is stored as 00:00 UTC the NEXT day, so UTC
// bucketing would file every night shift under the wrong column.
const tzParts = (d: Date, tz: string) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a: any, x) => (a[x.type] = x.value, a), {});
  // hour can come back as '24' at midnight in some ICU versions.
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, hhmm: `${String(hour).padStart(2, '0')}:${p.minute}` };
};
const parseYmd = (s: any, fb: Date) => {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  return fb;
};

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();

    // Sedes (selector) + selected sede.
    const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
    const sedes = (sedeRows || []).map((s: any) => ({ id: String(s.id), name: s.companyName || 'Sede' }));
    const requested = String(req.query.postSiteId || '');
    const selectedSedeId = sedes.find((s) => s.id === requested)?.id || sedes[0]?.id || null;

    // Tenant timezone drives both "today" and how each turno is bucketed into a
    // day column (see tzParts) — UTC would offset the whole grid for Ecuador.
    const tenantRow = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] }).catch(() => null);
    const tz = (tenantRow && tenantRow.timezone) || 'UTC';
    const todayStr = tzParts(now, tz).date;

    // Date window (default: today .. +13 days).
    const todayUtc = parseYmd(todayStr, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    const start = parseYmd(req.query.startDate, todayUtc);
    let end = parseYmd(req.query.endDate, new Date(start.getTime() + 13 * 86400000));
    if (end < start) end = new Date(start.getTime() + 13 * 86400000);
    // Cap window at 31 days.
    if ((end.getTime() - start.getTime()) / 86400000 > 31) end = new Date(start.getTime() + 31 * 86400000);
    const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const days: any[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const d = new Date(t);
      days.push({ date: ymd(d), dow: DOW[d.getUTCDay()], day: d.getUTCDate(), isToday: ymd(d) === ymd(todayUtc), weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 });
    }

    const empty = () => ApiResponseHandler.success(req, res, { sedes, selectedSedeId, startDate: ymd(start), endDate: ymd(end), days, stations: [], rows: [], updatedAt: now.toISOString() });
    if (!selectedSedeId) return empty();

    const stationRows = await db.station.findAll({
      where: { postSiteId: selectedSedeId, tenantId },
      attributes: ['id', 'stationName', 'scheduleType', 'rotationStyleId'],
      order: [['stationName', 'ASC']],
    });
    const stationIds = stationRows.map((s: any) => String(s.id));
    if (!stationIds.length) return empty();

    // Rotation styles.
    const rotRows = await db.rotationStyle.findAll({ where: { tenantId }, attributes: ['id', 'name', 'dayShifts', 'nightShifts', 'restDays'] }).catch(() => []);
    const rotById = new Map<string, any>(rotRows.map((r: any) => [String(r.id), r]));

    // Positions.
    const positions = await db.stationPosition.findAll({
      // deletedAt:null matches Programador › overview — without it a removed
      // puesto keeps rendering a phantom row here but not there.
      where: { tenantId, stationId: stationIds, deletedAt: null },
      attributes: ['id', 'stationId', 'name', 'type', 'startTime', 'endTime', 'guardsNeeded', 'sortOrder', 'platoonOffset'],
      order: [['stationId', 'ASC'], ['sortOrder', 'ASC']],
    }).catch(() => []);

    // Active assignments (with guard).
    const assigns = await db.guardAssignment.findAll({
      where: { tenantId, stationId: stationIds, status: 'active' },
      include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'platoonOffset', 'isRelief', 'startDate'],
    }).catch(() => []);
    const assignByPos = new Map<string, any>();
    for (const a of assigns) {
      if (a.positionId) assignByPos.set(String(a.positionId), a);
    }
    const guardName = (u: any) => u ? (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Vigilante') : null;

    const stationMeta = new Map<string, any>(stationRows.map((s: any) => [String(s.id), s]));

    // ── Real generated turnos for this sede's stations, in the window ────────
    // Padded ±1 day: an overnight turno that starts 19:00 local on the last
    // column is stored in UTC on the following day, and vice-versa at the head.
    const winStart = new Date(start.getTime() - 86400000);
    const winEnd = new Date(end.getTime() + 2 * 86400000);
    const shiftRows = await db.shift.findAll({
      where: {
        tenantId, stationId: stationIds, deletedAt: null,
        startTime: { [Op.gte]: winStart, [Op.lt]: winEnd },
      },
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'startTime', 'endTime'],
      include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
      order: [['startTime', 'ASC']],
    }).catch(() => []);

    // Bucket: positionId → date → shift. Shifts predating the positionId column
    // carry null, so fall back to a guard+station key the row can also build.
    const byPosDate = new Map<string, any>();
    const byGuardStationDate = new Map<string, any>();
    for (const sh of shiftRows) {
      const { date, hhmm, hour } = tzParts(new Date(sh.startTime), tz);
      const endLocal = tzParts(new Date(sh.endTime), tz);
      const entry = {
        status: (hour >= 18 || hour < 6) ? 'night' : 'day',
        hours: `${hhmm} - ${endLocal.hhmm}`,
        guardId: sh.guardId ? String(sh.guardId) : null,
        guardName: guardName(sh.guard),
      };
      if (sh.positionId) byPosDate.set(`${sh.positionId}|${date}`, entry);
      if (sh.guardId) byGuardStationDate.set(`${sh.guardId}|${sh.stationId}|${date}`, entry);
    }

    const rows: any[] = [];
    for (const p of positions) {
      const st = stationMeta.get(String(p.stationId));
      const rot = st?.rotationStyleId ? rotById.get(String(st.rotationStyleId)) : null;
      const a = assignByPos.get(String(p.id)) || null;
      const platoon = (a && a.platoonOffset != null) ? Number(a.platoonOffset) : (Number(p.platoonOffset) || 0);

      const cells = days.map((d: any) => {
        // 1. A real generated turno always wins — this is what Programador shows.
        const real = byPosDate.get(`${p.id}|${d.date}`)
          || (a?.guardId ? byGuardStationDate.get(`${a.guardId}|${p.stationId}|${d.date}`) : null);
        if (real) {
          return {
            date: d.date,
            status: real.status,
            hours: real.hours,
            // Surface who actually covers the day: on a sacafranco swap this is
            // NOT the row's titular vigilante.
            guardName: real.guardName,
            covering: !!(a?.guardId && real.guardId && real.guardId !== String(a.guardId)),
          };
        }
        // 2. No turno on a slot that HAS a rotation → it's a libre day, and we
        //    can say which kind the cycle expected. Without a rotation there is
        //    simply nothing scheduled ('none'), which is honest — the old code
        //    lied by painting 'rest' here.
        if (rot) {
          const dse = dseOf(new Date(`${d.date}T00:00:00Z`));
          const expected = rotationStatus(dse, platoon, Number(rot.dayShifts) || 0, Number(rot.nightShifts) || 0, Number(rot.restDays) || 0);
          return { date: d.date, status: expected === 'rest' ? 'rest' : 'gap', hours: null, guardName: null, covering: false };
        }
        return { date: d.date, status: 'none', hours: null, guardName: null, covering: false };
      });

      rows.push({
        stationId: String(p.stationId),
        stationName: st?.stationName || 'Estación',
        positionId: String(p.id),
        positionName: p.name || (p.type === 'sacafranco' ? 'Sacafranco' : 'Fijo'),
        positionType: p.type || 'fijo',
        window: p.startTime && p.endTime ? `${p.startTime} - ${p.endTime}` : null,
        assignmentId: a ? String(a.id) : null,
        guardId: a ? String(a.guardId) : null,
        guardName: a ? guardName(a.guard) : null,
        rotationStyleName: rot?.name || null,
        cells,
      });
    }

    const stations = stationRows.map((s: any) => ({ id: String(s.id), name: s.stationName, scheduleType: s.scheduleType, rotationStyleName: s.rotationStyleId ? (rotById.get(String(s.rotationStyleId))?.name || null) : null }));

    return ApiResponseHandler.success(req, res, {
      sedes, selectedSedeId,
      startDate: ymd(start), endDate: ymd(end),
      days, stations, rows,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
