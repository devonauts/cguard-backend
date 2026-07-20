import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import { requiredHalves, stationReqFromPositions } from '../../services/scheduleCoverageService';

/**
 * Live "Puestos y cobertura" for one sede (post site) of a client.
 *
 * A "puesto" is a `station`. Coverage is computed from REAL operations:
 *  - who is punched in NOW  → guardShift (stationNameId, punchOutTime IS NULL)
 *  - what's scheduled NOW    → shift rows whose window contains now
 *  - required per station    → stationPosition (fijo) demand
 * No fabricated numbers. Everything degrades to safe defaults on error.
 */

const hhmm = (d: Date, tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d);
  } catch { return new Date(d).toISOString().slice(11, 16); }
};
const localHour = (d: Date, tz: string) => {
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d), 10);
    return Number.isFinite(h) ? h % 24 : new Date(d).getUTCHours();
  } catch { return new Date(d).getUTCHours(); }
};
const localYmd = (d: Date, tz: string) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return new Date(d).toISOString().slice(0, 10); }
};
// Longest plausible open turno. Past this a punch is a leftover, not presence:
// the longest real turno is 24h, +6h of grace for a late manual clock-out.
const STALE_PUNCH_HOURS = 30;
// Turno band from a start hour (matches the operational vocabulary).
const bandOfHour = (h: number): 'diurno' | 'vespertino' | 'nocturno' =>
  h >= 5 && h < 13 ? 'diurno' : h >= 13 && h < 21 ? 'vespertino' : 'nocturno';
const bandLabel = { diurno: 'Diurno', vespertino: 'Vespertino', nocturno: 'Nocturno' } as const;
const toNum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// "07:00" → minutes; supports wrap for night windows in coversNow().
const minutesOf = (hhmmStr?: string | null) => {
  if (!hhmmStr) return null;
  const [h, m] = String(hhmmStr).split(':').map((x) => parseInt(x, 10));
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
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
    const horizonMin = Math.min(720, Math.max(30, parseInt(String(req.query.horizonMin || '120'), 10) || 120));

    // Tenant timezone + coverage objective.
    let tz = 'America/Guayaquil';
    let objetivoPct = 95;
    try {
      const tnt = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
      if (tnt?.timezone) tz = tnt.timezone;
      const client = await db.clientAccount.findByPk(clientAccountId, { attributes: ['slaUptimeTarget'] });
      if (client?.slaUptimeTarget != null) objetivoPct = Number(client.slaUptimeTarget) || 95;
    } catch { /* defaults */ }

    // ── Sedes of this client (selector) ──────────────────────────────────────
    const sedeRows = await db.businessInfo.findAll({
      where: { clientAccountId, tenantId },
      attributes: ['id', 'companyName', 'address', 'city', 'latitud', 'longitud'],
      order: [['companyName', 'ASC']],
    });
    const sedes = (sedeRows || []).map((s: any) => ({
      id: String(s.id),
      name: s.companyName || 'Sede',
      address: [s.address, s.city].filter(Boolean).join(', ') || null,
      lat: toNum(s.latitud),
      lng: toNum(s.longitud),
    }));

    if (!sedes.length) {
      return ApiResponseHandler.success(req, res, {
        sedes: [], selectedSedeId: null, tz, objetivoPct, puestos: [],
        kpis: emptyKpis(), turnoSummary: emptyTurnos(), sinCobertura: [], proximos: [], updatedAt: now.toISOString(),
      });
    }

    const requested = String(req.query.postSiteId || '');
    const selectedSedeId = sedes.find((s) => s.id === requested)?.id || sedes[0].id;

    // ── Stations (puestos) of the selected sede ──────────────────────────────
    const stationRows = await db.station.findAll({
      where: { postSiteId: selectedSedeId, tenantId },
      attributes: ['id', 'stationName', 'nickname', 'latitud', 'longitud', 'scheduleType', 'startingTimeInDay', 'finishTimeInDay', 'numberOfGuardsInStation'],
      order: [['stationName', 'ASC']],
    });
    const stations = stationRows || [];
    const stationIds = stations.map((s: any) => String(s.id));

    if (!stationIds.length) {
      return ApiResponseHandler.success(req, res, {
        sedes, selectedSedeId, tz, objetivoPct, puestos: [],
        kpis: emptyKpis(), turnoSummary: emptyTurnos(), sinCobertura: [], proximos: [], updatedAt: now.toISOString(),
      });
    }

    // ── Positions (fijo demand) per station ──────────────────────────────────
    const positions = await db.stationPosition.findAll({
      where: { tenantId, stationId: stationIds },
      attributes: ['id', 'stationId', 'type', 'startTime', 'endTime', 'guardsNeeded'],
    }).catch(() => []);
    const fijoByStation = new Map<string, any[]>();
    for (const p of positions) {
      if (String(p.type) !== 'fijo') continue;
      const k = String(p.stationId);
      if (!fijoByStation.has(k)) fijoByStation.set(k, []);
      fijoByStation.get(k)!.push(p);
    }

    // ── Scheduled shifts active NOW + upcoming (per station) ──────────────────
    const activeShifts = await db.shift.findAll({
      where: { tenantId, stationId: stationIds, startTime: { [Op.lte]: now }, endTime: { [Op.gte]: now } },
      attributes: ['stationId', 'guardId', 'startTime', 'endTime'],
    }).catch(() => []);
    const activeByStation = new Map<string, any[]>();
    for (const s of activeShifts) {
      const k = String(s.stationId);
      if (!activeByStation.has(k)) activeByStation.set(k, []);
      activeByStation.get(k)!.push(s);
    }

    const horizonEnd = new Date(now.getTime() + horizonMin * 60000);
    const upcoming = await db.shift.findAll({
      where: { tenantId, stationId: stationIds, startTime: { [Op.gt]: now, [Op.lte]: horizonEnd } },
      attributes: ['stationId', 'startTime', 'endTime'],
      order: [['startTime', 'ASC']],
    }).catch(() => []);
    const nextByStation = new Map<string, any>();
    for (const s of upcoming) {
      const k = String(s.stationId);
      if (!nextByStation.has(k)) nextByStation.set(k, s);
    }

    // ── Who's punched in NOW (direct station FK) ─────────────────────────────
    // A punch with no punchOutTime used to count as "presente ahora" forever, so
    // a guard who never closed their turno haunted the client's coverage for
    // days — even at a client they aren't assigned to. Nobody works a 5-day
    // turno: bound the window so only a plausibly-live punch counts. The
    // forced-clock-out sweeper closes the rest (see forcedClockOutService).
    const openPunchFloor = new Date(now.getTime() - STALE_PUNCH_HOURS * 3600 * 1000);
    const openShifts = await db.guardShift.findAll({
      where: {
        tenantId, stationNameId: stationIds, punchOutTime: null,
        punchInTime: { [Op.gte]: openPunchFloor },
      },
      attributes: ['id', 'stationNameId', 'guardNameId', 'punchInTime'],
    }).catch(() => []);
    const onPostByStation = new Map<string, any[]>();
    const guardNameIds = new Set<string>();
    for (const gs of openShifts) {
      const k = String(gs.stationNameId);
      if (!onPostByStation.has(k)) onPostByStation.set(k, []);
      onPostByStation.get(k)!.push(gs);
      if (gs.guardNameId) guardNameIds.add(String(gs.guardNameId));
    }

    // ── Guards ASSIGNED to each station (guardAssignment = source of truth) ──
    // Coverage is LIVE (marcaciones), but the UI must be able to say "asignados
    // que no han marcado" instead of the misleading "sin asignar".
    const assignedByStation = new Map<string, string[]>();
    try {
      const assigns = await db.guardAssignment.findAll({
        where: { tenantId, stationId: stationIds, status: 'active' },
        attributes: ['stationId'],
        include: [{ model: db.user, as: 'guard', attributes: ['fullName', 'firstName', 'lastName'] }],
      });
      for (const a of assigns) {
        const k = String(a.stationId);
        const u: any = a.guard || {};
        const nm = u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Vigilante';
        if (!assignedByStation.has(k)) assignedByStation.set(k, []);
        assignedByStation.get(k)!.push(nm);
      }
    } catch { /* best-effort enrichment */ }

    // ── Last check-in today per station + attendance bands for turno summary ──
    const todayStr = localYmd(now, tz);
    const dayStart = new Date(now.getTime() - 26 * 3600 * 1000); // wide enough to capture today's punches
    const todayGuardShifts = await db.guardShift.findAll({
      where: { tenantId, stationNameId: stationIds, punchInTime: { [Op.gte]: dayStart } },
      attributes: ['stationNameId', 'guardNameId', 'punchInTime'],
      order: [['punchInTime', 'DESC']],
    }).catch(() => []);
    const lastCheckinByStation = new Map<string, Date>();
    const attendedBand: Record<string, number> = { diurno: 0, vespertino: 0, nocturno: 0 };
    for (const gs of todayGuardShifts) {
      const k = String(gs.stationNameId);
      const t = gs.punchInTime ? new Date(gs.punchInTime) : null;
      if (!t) continue;
      if (!lastCheckinByStation.has(k)) lastCheckinByStation.set(k, t);
      if (localYmd(t, tz) === todayStr) attendedBand[bandOfHour(localHour(t, tz))] += 1;
      if (guardNameIds.size < 500 && guardNameIds.size >= 0) guardNameIds.add(String(gs.guardNameId));
    }

    // Resolve guard display names (securityGuard.id → fullName).
    const nameById = new Map<string, string>();
    if (guardNameIds.size) {
      const guards = await db.securityGuard.findAll({
        where: { tenantId, id: Array.from(guardNameIds) },
        attributes: ['id', 'fullName'],
      }).catch(() => []);
      for (const g of guards) nameById.set(String(g.id), g.fullName || 'Vigilante');
    }

    // ── Patrol type + active ronda (recent tagScan) ──────────────────────────
    const patrolStationIds = new Set<string>();
    try {
      const tours = await db.siteTour.findAll({ where: { tenantId, stationId: stationIds, active: true }, attributes: ['stationId'] });
      for (const t of tours) if (t.stationId) patrolStationIds.add(String(t.stationId));
    } catch { /* optional */ }
    const rondaActiveStations = new Set<string>();
    try {
      const since = new Date(now.getTime() - 30 * 60000);
      const scans = await db.tagScan.findAll({ where: { tenantId, stationId: stationIds, scannedAt: { [Op.gte]: since } }, attributes: ['stationId'] });
      for (const sc of scans) if (sc.stationId) rondaActiveStations.add(String(sc.stationId));
    } catch { /* optional */ }

    // ── Today's scheduled shifts per band (required side of turno summary) ────
    const requiredBand: Record<string, number> = { diurno: 0, vespertino: 0, nocturno: 0 };
    try {
      const todayShifts = await db.shift.findAll({
        where: { tenantId, stationId: stationIds, startTime: { [Op.gte]: dayStart } },
        attributes: ['startTime'],
      });
      for (const s of todayShifts) {
        const t = new Date(s.startTime);
        if (localYmd(t, tz) !== todayStr) continue;
        requiredBand[bandOfHour(localHour(t, tz))] += 1;
      }
    } catch { /* optional */ }

    // ── Build each puesto ────────────────────────────────────────────────────
    const nowHour = localHour(now, tz);
    const nowMin = nowHour * 60 + Number(new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: tz }).format(now) || 0);
    const coversNow = (start?: string | null, end?: string | null) => {
      const s = minutesOf(start); const e = minutesOf(end);
      if (s == null || e == null) return false;
      return s <= e ? (nowMin >= s && nowMin < e) : (nowMin >= s || nowMin < e); // wrap for night
    };

    let sumCoveredNow = 0, sumRequiredNow = 0;
    const puestos = stations.map((st: any) => {
      const id = String(st.id);
      const fijos = fijoByStation.get(id) || [];
      const req = stationReqFromPositions({ id, stationName: st.stationName, scheduleType: st.scheduleType }, fijos);
      const currentHalf = nowHour >= 18 || nowHour < 6 ? 'night' : 'day';

      const active = activeByStation.get(id) || [];
      const onPost = onPostByStation.get(id) || [];
      const onPostCount = onPost.length;

      // The station's own configuration is authoritative for how many guards the
      // post needs and whether it runs around the clock. A 24h post is never
      // "off turno" and always needs its full complement — independent of whether
      // shifts/positions were materialized in the schedule.
      const configuredGuards = Math.max(1, Number(st.numberOfGuardsInStation) || 1);
      const is24h =
        String(st.scheduleType || '').toLowerCase().replace(/\s/g, '') === '24h' ||
        (String(st.startingTimeInDay) === '00:00' &&
          ['23:59', '24:00', '00:00'].includes(String(st.finishTimeInDay)));

      // Required NOW: prefer generated shifts; fall back to positions covering now.
      let requiredNow = active.length;
      let windowStart: Date | null = active.length ? new Date(Math.min(...active.map((a: any) => +new Date(a.startTime)))) : null;
      let windowEnd: Date | null = active.length ? new Date(Math.max(...active.map((a: any) => +new Date(a.endTime)))) : null;
      let hasTurnoNow = active.length > 0;

      if (!hasTurnoNow) {
        const fijosNow = fijos.filter((p: any) => coversNow(p.startTime, p.endTime));
        if (fijosNow.length) {
          hasTurnoNow = true;
          requiredNow = fijosNow.reduce((a: number, p: any) => a + (Number(p.guardsNeeded) || 1), 0);
        } else if (!fijos.length && (requiredHalves(st.scheduleType).includes(currentHalf as any))) {
          // Configured schedule type but no positions/shifts materialized.
          hasTurnoNow = true;
          requiredNow = Math.max(configuredGuards, req.halfCounts?.[currentHalf as 'day' | 'night'] ?? configuredGuards);
        }
      }
      if (onPostCount > 0) hasTurnoNow = true;

      // 24h posts: always on turno, and always demand the full configured guard
      // complement (never fewer than what materialized).
      if (is24h) {
        hasTurnoNow = true;
        requiredNow = Math.max(requiredNow, configuredGuards);
        windowStart = null;
        windowEnd = null;
      }

      // "sin_cobertura" (red, critical) means the post is genuinely unstaffed. If
      // there ARE guards assigned to this station who simply haven't punched in
      // yet, that's a milder "asignado_sin_marcar" (amber) — not an abandonment.
      const hasAssigned = (assignedByStation.get(id)?.length || 0) > 0;
      let status: 'cubierto' | 'parcial' | 'sin_cobertura' | 'asignado_sin_marcar' | 'sin_turno';
      if (!hasTurnoNow) status = 'sin_turno';
      else {
        const need = Math.max(1, requiredNow);
        status = onPostCount >= need
          ? 'cubierto'
          : onPostCount > 0
            ? 'parcial'
            : hasAssigned
              ? 'asignado_sin_marcar'
              : 'sin_cobertura';
      }

      if (hasTurnoNow) { sumCoveredNow += Math.min(onPostCount, Math.max(1, requiredNow)); sumRequiredNow += Math.max(1, requiredNow); }

      // Window label. A 24h post shows the full-day window + a "24 horas" turno,
      // not whatever partial shift/position happens to cover the current instant.
      let windowLabel = '';
      let bandName: 'diurno' | 'vespertino' | 'nocturno' | null = null;
      let turnoText: string | null = null;
      if (is24h) {
        windowLabel = '00:00 - 23:59';
        turnoText = '24 horas';
      } else if (windowStart && windowEnd) {
        windowLabel = `${hhmm(windowStart, tz)} - ${hhmm(windowEnd, tz)}`;
        bandName = bandOfHour(localHour(windowStart, tz));
      } else {
        const fijosNow = fijos.filter((p: any) => coversNow(p.startTime, p.endTime));
        if (fijosNow.length) {
          windowLabel = `${fijosNow[0].startTime} - ${fijosNow[0].endTime}`;
          bandName = bandOfHour(parseInt(String(fijosNow[0].startTime).split(':')[0], 10) || 0);
        } else if (st.startingTimeInDay && st.finishTimeInDay) {
          windowLabel = `${st.startingTimeInDay} - ${st.finishTimeInDay}`;
        }
      }
      if (!turnoText) turnoText = bandName ? bandLabel[bandName] : null;

      // Last activity
      const lastCheckin = lastCheckinByStation.get(id) || null;
      let lastActivity: any = { type: 'none' };
      if (rondaActiveStations.has(id)) lastActivity = { type: 'ronda' };
      else if (lastCheckin) lastActivity = { type: 'checkin', time: hhmm(lastCheckin, tz) };

      const requiredForPct = Math.max(1, requiredNow);
      const coveragePct = !hasTurnoNow ? null : Math.min(100, Math.round((onPostCount / requiredForPct) * 100));
      const hasNovelty = status === 'sin_cobertura' || status === 'parcial';

      return {
        id,
        name: st.stationName,
        nickname: st.nickname || null,
        type: patrolStationIds.has(id) ? 'patrulla' : 'fijo',
        lat: toNum(st.latitud),
        lng: toNum(st.longitud),
        window: windowLabel || null,
        turno: turnoText,
        required: Math.max(0, requiredNow),
        onPost: onPostCount,
        guards: onPost.map((gs: any) => nameById.get(String(gs.guardNameId)) || 'Vigilante'),
        assigned: assignedByStation.get(id) || [],
        coveragePct,
        status,
        lastActivity,
        hasNovelty,
        nextShiftAt: nextByStation.get(id) ? new Date(nextByStation.get(id).startTime).toISOString() : null,
      };
    });

    // ── KPIs ─────────────────────────────────────────────────────────────────
    const puestosCubiertos = puestos.filter((p) => p.status === 'cubierto').length;
    const puestosSinCobertura = puestos.filter((p) => p.status === 'sin_cobertura').length;
    const puestosConNovedad = puestos.filter((p) => p.hasNovelty).length;
    const guardiasEnPuestos = puestos.reduce((a, p) => a + p.onPost, 0);
    const guardiasRequeridas = puestos.reduce((a, p) => a + (p.status === 'sin_turno' ? 0 : Math.max(1, p.required)), 0);
    const coberturaPct = sumRequiredNow ? Math.round((sumCoveredNow / sumRequiredNow) * 100) : 100;

    // Próximos a iniciar (within horizon)
    const proximos = stations
      .map((st: any) => {
        const nx = nextByStation.get(String(st.id));
        if (!nx) return null;
        const startsInMin = Math.round((+new Date(nx.startTime) - +now) / 60000);
        return {
          id: String(st.id), name: st.stationName,
          window: `${hhmm(new Date(nx.startTime), tz)} - ${hhmm(new Date(nx.endTime), tz)}`,
          turno: bandLabel[bandOfHour(localHour(new Date(nx.startTime), tz))],
          startsInMin,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.startsInMin - b.startsInMin);

    const cumplimientoHoy = (() => {
      const req = requiredBand.diurno + requiredBand.vespertino + requiredBand.nocturno;
      const att = attendedBand.diurno + attendedBand.vespertino + attendedBand.nocturno;
      return req ? Math.min(100, Math.round((att / req) * 100)) : 100;
    })();

    const kpis = {
      puestosTotales: puestos.length,
      puestosCubiertos,
      coberturaPct,
      guardiasEnPuestos,
      guardiasRequeridas,
      puestosSinCobertura,
      proximosAIniciar: proximos.length,
      puestosConNovedad,
      cumplimientoHoy,
    };

    // ── Turno summary (por banda, según hoy) ─────────────────────────────────
    const bands: Array<'diurno' | 'vespertino' | 'nocturno'> = ['diurno', 'vespertino', 'nocturno'];
    const windowByBand = { diurno: '06:00 - 14:00', vespertino: '14:00 - 22:00', nocturno: '22:00 - 06:00' };
    const turnoSummary = bands.map((b) => {
      const required = requiredBand[b];
      const covered = Math.min(attendedBand[b], required || attendedBand[b]);
      return {
        key: b, label: bandLabel[b], window: windowByBand[b],
        required, covered,
        pct: required ? Math.min(100, Math.round((covered / required) * 100)) : 0,
      };
    });
    const totReq = turnoSummary.reduce((a, t) => a + t.required, 0);
    const totCov = turnoSummary.reduce((a, t) => a + t.covered, 0);
    const generalPct = totReq ? Math.round((totCov / totReq) * 100) : 100;

    // Sin cobertura list
    const sinCobertura = puestos
      .filter((p) => p.status === 'sin_cobertura')
      .map((p) => ({ id: p.id, name: p.name, window: p.window, turno: p.turno, requiredGuards: Math.max(1, p.required) }));

    return ApiResponseHandler.success(req, res, {
      sedes,
      selectedSedeId,
      tz,
      objetivoPct,
      kpis,
      puestos,
      turnoSummary,
      generalPct,
      sinCobertura,
      proximos,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

function emptyKpis() {
  return { puestosTotales: 0, puestosCubiertos: 0, coberturaPct: 100, guardiasEnPuestos: 0, guardiasRequeridas: 0, puestosSinCobertura: 0, proximosAIniciar: 0, puestosConNovedad: 0, cumplimientoHoy: 100 };
}
function emptyTurnos() {
  return [
    { key: 'diurno', label: 'Diurno', window: '06:00 - 14:00', required: 0, covered: 0, pct: 0 },
    { key: 'vespertino', label: 'Vespertino', window: '14:00 - 22:00', required: 0, covered: 0, pct: 0 },
    { key: 'nocturno', label: 'Nocturno', window: '22:00 - 06:00', required: 0, covered: 0, pct: 0 },
  ];
}
