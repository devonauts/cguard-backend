import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Live "Personal asignado" roster for a client, across all its sedes.
 *
 * Personnel are resolved from real assignments to the client's stations:
 *  - Guardia  = securityGuard with an active guardAssignment on a client station
 *  - Supervisor / Patrullero = supervisorPositionAssignment whose supervisorPosition
 *    covers a client station (patrullero = that position has a mobile station)
 * Live status/hours/absences/licenses all from real ops. No fabricated data.
 * Table filters (q/sede/role/estado/turno) + pagination apply only to the list;
 * KPIs, role distribution, coverage, certs and absences are client-wide.
 */

const GRACE_MIN = 30;

const hhmm = (d: Date, tz: string) => {
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d); }
  catch { return new Date(d).toISOString().slice(11, 16); }
};
const localHour = (d: Date, tz: string) => {
  try { const h = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d), 10); return Number.isFinite(h) ? h % 24 : new Date(d).getUTCHours(); }
  catch { return new Date(d).getUTCHours(); }
};
const localYmd = (d: Date, tz: string) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return new Date(d).toISOString().slice(0, 10); }
};
const bandOfHour = (h: number): 'diurno' | 'vespertino' | 'nocturno' =>
  h >= 5 && h < 13 ? 'diurno' : h >= 13 && h < 21 ? 'vespertino' : 'nocturno';
const bandLabel = { diurno: 'Diurno', vespertino: 'Vespertino', nocturno: 'Nocturno' } as const;

async function avatarUrl(fileArr: any) {
  try {
    if (Array.isArray(fileArr) && fileArr.length) {
      const filled = await FileRepository.fillDownloadUrl(fileArr);
      return filled?.[0]?.downloadUrl || null;
    }
  } catch { /* ignore */ }
  return null;
}

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let tz = 'America/Guayaquil';
    let metaCobertura = 95;
    try {
      const tnt = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
      if (tnt?.timezone) tz = tnt.timezone;
      const cli = await db.clientAccount.findByPk(clientAccountId, { attributes: ['slaUptimeTarget', 'name'] });
      if (cli?.slaUptimeTarget != null) metaCobertura = Number(cli.slaUptimeTarget) || 95;
    } catch { /* defaults */ }

    // ── Client sedes + stations ──────────────────────────────────────────────
    const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
    const siteIds = sedeRows.map((s: any) => String(s.id));
    const sedeNameById = new Map<string, string>(sedeRows.map((s: any) => [String(s.id), s.companyName || 'Sede']));
    const sedes = sedeRows.map((s: any) => ({ id: String(s.id), name: s.companyName || 'Sede' }));

    const stationRows = await db.station.findAll({
      where: { tenantId, [Op.or]: [{ stationOriginId: clientAccountId }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
      attributes: ['id', 'stationName', 'postSiteId', 'startingTimeInDay', 'finishTimeInDay', 'isMobile'],
    });
    const stationIds = stationRows.map((s: any) => String(s.id));
    const stationMeta = new Map<string, any>(stationRows.map((s: any) => [String(s.id), {
      name: s.stationName,
      sedeId: s.postSiteId ? String(s.postSiteId) : null,
      sedeName: s.postSiteId ? (sedeNameById.get(String(s.postSiteId)) || 'Sede') : 'General',
    }]));

    const empty = () => ApiResponseHandler.success(req, res, {
      tz, sedes, kpis: { totalAsignados: 0, enTurno: 0, enTurnoPct: 0, fueraTurno: 0, fueraTurnoPct: 0, descanso: 0, descansoPct: 0, ausentes: 0, ausentesPct: 0, proximosVencer: 0, cumplimientoCobertura: 100, metaCobertura, horasMes: 0 },
      roleDistribution: [
        { key: 'guardia', label: 'Guardias', count: 0, pct: 0 }, { key: 'supervisor', label: 'Supervisores', count: 0, pct: 0 },
        { key: 'patrullero', label: 'Patrulleros', count: 0, pct: 0 }, { key: 'operador', label: 'Operadores', count: 0, pct: 0 },
      ],
      total: 0, personal: [], coberturaTurno: [], certificaciones: [], ausenciasHoy: [], page: 1, perPage: 10, updatedAt: now.toISOString(),
    });
    if (!stationIds.length) return empty();

    // ── Live shift context ───────────────────────────────────────────────────
    const openGuardShifts = await db.guardShift.findAll({
      where: { tenantId, punchOutTime: null, [Op.or]: [{ stationNameId: stationIds }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
      attributes: ['guardNameId', 'punchInTime', 'stationNameId'],
      order: [['punchInTime', 'DESC']],
    }).catch(() => []);
    const openBySg = new Map<string, any>();
    for (const gs of openGuardShifts) { const k = String(gs.guardNameId); if (!openBySg.has(k)) openBySg.set(k, gs); }

    // Today's generated shifts (per guard user) + coverage bands.
    const dayStart = new Date(now.getTime() - 26 * 3600 * 1000);
    const todayShifts = await db.shift.findAll({
      where: { tenantId, stationId: stationIds, startTime: { [Op.gte]: dayStart } },
      attributes: ['guardId', 'stationId', 'startTime', 'endTime'],
    }).catch(() => []);
    const todayStr = localYmd(now, tz);
    const shiftsByGuardUser = new Map<string, any[]>();
    const requiredBand: Record<string, number> = { diurno: 0, vespertino: 0, nocturno: 0 };
    for (const s of todayShifts) {
      const t = new Date(s.startTime);
      if (localYmd(t, tz) === todayStr) requiredBand[bandOfHour(localHour(t, tz))] += 1;
      const k = String(s.guardId);
      if (!shiftsByGuardUser.has(k)) shiftsByGuardUser.set(k, []);
      shiftsByGuardUser.get(k)!.push(s);
    }

    // Last check-in + attendance bands (today).
    const todayGuardShifts = await db.guardShift.findAll({
      where: { tenantId, punchInTime: { [Op.gte]: dayStart }, [Op.or]: [{ stationNameId: stationIds }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
      attributes: ['guardNameId', 'punchInTime', 'hoursWorked'],
      order: [['punchInTime', 'DESC']],
    }).catch(() => []);
    const lastCheckinBySg = new Map<string, Date>();
    const attendedBand: Record<string, number> = { diurno: 0, vespertino: 0, nocturno: 0 };
    for (const gs of todayGuardShifts) {
      const k = String(gs.guardNameId);
      const t = gs.punchInTime ? new Date(gs.punchInTime) : null;
      if (!t) continue;
      if (!lastCheckinBySg.has(k)) lastCheckinBySg.set(k, t);
      if (localYmd(t, tz) === todayStr) attendedBand[bandOfHour(localHour(t, tz))] += 1;
    }

    // Recent ronda scans (30 min) by securityGuard.
    const rondaSgSet = new Set<string>();
    try {
      const since = new Date(now.getTime() - 30 * 60000);
      const scans = await db.tagScan.findAll({ where: { tenantId, stationId: stationIds, scannedAt: { [Op.gte]: since } }, attributes: ['securityGuardId'] });
      for (const sc of scans) if (sc.securityGuardId) rondaSgSet.add(String(sc.securityGuardId));
    } catch { /* optional */ }

    // ── GUARDS roster ────────────────────────────────────────────────────────
    const gAssign = await db.guardAssignment.findAll({
      where: { tenantId, stationId: stationIds, status: 'active' },
      attributes: ['id', 'guardId', 'stationId'],
    }).catch(() => []);
    const guardStationByUser = new Map<string, string>();
    // guardId → active assignment id, so the CRM can "remover de la estación"
    // (DELETE /guard-assignment/:id) straight from the roster row.
    const assignmentByUser = new Map<string, string>();
    for (const a of gAssign) {
      const k = String(a.guardId);
      if (!guardStationByUser.has(k)) guardStationByUser.set(k, String(a.stationId));
      if (!assignmentByUser.has(k)) assignmentByUser.set(k, String(a.id));
    }
    const guardUserIds = [...guardStationByUser.keys()];

    let guardRows: any[] = [];
    if (guardUserIds.length) {
      guardRows = await db.securityGuard.findAll({
        where: { tenantId, guardId: guardUserIds },
        attributes: ['id', 'fullName', 'governmentId', 'guardId', 'isOnDuty'],
        include: [{ model: db.file, as: 'profileImage', required: false }],
      }).catch(() => []);
    }

    const coversNowShift = (s: any) => { const st = +new Date(s.startTime); const en = +new Date(s.endTime); return st <= +now && +now <= en; };

    const roster: any[] = [];
    for (const g of guardRows) {
      const sgId = String(g.id);
      const userId = g.guardId ? String(g.guardId) : null;
      const stId = userId ? guardStationByUser.get(userId) : null;
      const meta = stId ? stationMeta.get(stId) : null;
      const open = openBySg.get(sgId) || null;

      const myShifts = userId ? (shiftsByGuardUser.get(userId) || []) : [];
      const activeShift = myShifts.find(coversNowShift) || null;
      const pastGrace = activeShift && (+now > +new Date(activeShift.startTime) + GRACE_MIN * 60000);

      let estado: string;
      if (open) estado = 'en_turno';
      else if (activeShift && pastGrace) estado = 'ausente';
      else estado = 'fuera_turno';

      // Turno window
      let window: string | null = null, tband: string | null = null;
      if (activeShift) { window = `${hhmm(new Date(activeShift.startTime), tz)} - ${hhmm(new Date(activeShift.endTime), tz)}`; tband = bandLabel[bandOfHour(localHour(new Date(activeShift.startTime), tz))]; }
      else if (open) { window = `Desde ${hhmm(new Date(open.punchInTime), tz)}`; tband = bandLabel[bandOfHour(localHour(new Date(open.punchInTime), tz))]; }
      else if (meta && stationMeta.get(stId!)) { /* fallback none */ }

      // Última actividad
      const lastCk = lastCheckinBySg.get(sgId) || null;
      let ultimaActividad: any = null;
      if (rondaSgSet.has(sgId)) ultimaActividad = { type: 'ronda', label: 'Ronda activa' };
      else if (open) ultimaActividad = { type: 'checkin', label: 'Check-in', time: hhmm(new Date(open.punchInTime), tz) };
      else if (lastCk) ultimaActividad = { type: 'checkin', label: 'Check-in', time: hhmm(lastCk, tz) };

      roster.push({
        id: sgId,
        guardId: userId,
        assignmentId: (userId && assignmentByUser.get(userId)) || null,
        stationId: (userId && guardStationByUser.get(userId)) || null,
        name: g.fullName || '—',
        code: g.governmentId ? String(g.governmentId) : null,
        role: 'guardia',
        roleLabel: 'Guardia',
        puesto: meta?.name || null,
        sede: meta?.sedeName || null,
        sedeId: meta?.sedeId || null,
        turno: window ? { window, label: tband } : null,
        estado,
        inicioTurno: open ? hhmm(new Date(open.punchInTime), tz) : (activeShift ? hhmm(new Date(activeShift.startTime), tz) : null),
        ultimaActividad,
        photoUrl: await avatarUrl(g.profileImage),
        _sortName: g.fullName || '',
      });
    }

    // ── SUPERVISORS / PATRULLEROS roster ─────────────────────────────────────
    try {
      const positions = await db.supervisorPosition.findAll({ where: { tenantId }, attributes: ['id', 'name', 'zone', 'mobileStationId', 'stationIds', 'startTime', 'endTime'] });
      const stationIdSet = new Set(stationIds);
      const matchPositions = positions.filter((p: any) => {
        if (p.mobileStationId && stationIdSet.has(String(p.mobileStationId))) return true;
        const arr = Array.isArray(p.stationIds) ? p.stationIds : [];
        return arr.some((sid: any) => stationIdSet.has(String(sid)));
      });
      const posById = new Map<string, any>(matchPositions.map((p: any) => [String(p.id), p]));
      if (matchPositions.length) {
        const assigns = await db.supervisorPositionAssignment.findAll({
          where: { tenantId, positionId: [...posById.keys()], status: 'active' },
          attributes: ['supervisorUserId', 'positionId'],
        }).catch(() => []);
        const supUserIds = [...new Set(assigns.map((a: any) => String(a.supervisorUserId)))];
        if (supUserIds.length) {
          const openSup = await db.supervisorShift.findAll({ where: { tenantId, punchOutTime: null, supervisorUserId: supUserIds }, attributes: ['supervisorUserId', 'punchInTime', 'breaks'] }).catch(() => []);
          const openSupBy = new Map<string, any>();
          for (const s of openSup) if (!openSupBy.has(String(s.supervisorUserId))) openSupBy.set(String(s.supervisorUserId), s);

          const users = await db.user.findAll({ where: { id: supUserIds }, attributes: ['id', 'fullName', 'firstName', 'lastName'] }).catch(() => []);
          const userById = new Map<string, any>(users.map((u: any) => [String(u.id), u]));

          // recent GPS (en ruta) for supervisors
          const enRutaUsers = new Set<string>();
          try {
            const since = new Date(now.getTime() - 15 * 60000);
            const pings = await db.locationPing.findAll({ where: { tenantId, subjectType: 'supervisor', userId: supUserIds, recordedAt: { [Op.gte]: since } }, attributes: ['userId'] });
            for (const p of pings) if (p.userId) enRutaUsers.add(String(p.userId));
          } catch { /* optional */ }

          const seen = new Set<string>();
          for (const a of assigns) {
            const uid = String(a.supervisorUserId);
            if (seen.has(uid)) continue;
            seen.add(uid);
            const pos = posById.get(String(a.positionId));
            const u = userById.get(uid);
            const name = u?.fullName || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Supervisor';
            const isMobile = !!(pos?.mobileStationId);
            const open = openSupBy.get(uid) || null;
            const breaks = Array.isArray(open?.breaks) ? open.breaks : [];
            const onBreak = breaks.length && breaks[breaks.length - 1]?.end == null;

            let estado: string;
            if (onBreak) estado = 'descanso';
            else if (open) estado = (isMobile && enRutaUsers.has(uid)) ? 'en_ruta' : 'en_turno';
            else estado = 'fuera_turno';

            const window = pos?.startTime && pos?.endTime ? `${pos.startTime} - ${pos.endTime}` : (open ? `Desde ${hhmm(new Date(open.punchInTime), tz)}` : null);
            const tband = window && pos?.startTime ? bandLabel[bandOfHour(parseInt(String(pos.startTime).split(':')[0], 10) || 0)] : (open ? bandLabel[bandOfHour(localHour(new Date(open.punchInTime), tz))] : null);

            roster.push({
              id: `sup-${uid}`,
              guardId: uid,
              name,
              code: null,
              role: isMobile ? 'patrullero' : 'supervisor',
              roleLabel: isMobile ? 'Patrullero' : 'Supervisor',
              puesto: pos?.name || 'Supervisión',
              sede: pos?.zone || null,
              sedeId: null,
              turno: window ? { window, label: tband } : null,
              estado,
              inicioTurno: open ? hhmm(new Date(open.punchInTime), tz) : null,
              ultimaActividad: open ? { type: 'checkin', label: 'Check-in', time: hhmm(new Date(open.punchInTime), tz) } : null,
              photoUrl: null,
              _sortName: name,
            });
          }
        }
      }
    } catch { /* supervisors optional */ }

    // ── Role distribution ────────────────────────────────────────────────────
    const roleCount = { guardia: 0, supervisor: 0, patrullero: 0, operador: 0 } as Record<string, number>;
    for (const r of roster) roleCount[r.role] = (roleCount[r.role] || 0) + 1;
    const totalRoster = roster.length;
    const pctOf = (n: number) => (totalRoster ? Math.round((n / totalRoster) * 100) : 0);
    const roleDistribution = [
      { key: 'guardia', label: 'Guardias', count: roleCount.guardia, pct: pctOf(roleCount.guardia) },
      { key: 'supervisor', label: 'Supervisores', count: roleCount.supervisor, pct: pctOf(roleCount.supervisor) },
      { key: 'patrullero', label: 'Patrulleros', count: roleCount.patrullero, pct: pctOf(roleCount.patrullero) },
      { key: 'operador', label: 'Operadores', count: roleCount.operador, pct: pctOf(roleCount.operador) },
    ];

    // ── KPIs ─────────────────────────────────────────────────────────────────
    const cnt = (st: string) => roster.filter((r) => r.estado === st).length;
    const enTurno = cnt('en_turno') + cnt('en_ruta');
    const fueraTurno = cnt('fuera_turno');
    const descanso = cnt('descanso');
    const ausentes = cnt('ausente');

    // Hours this month (guards + supervisors).
    let horasMes = 0;
    try {
      const rows = await db.guardShift.findAll({
        where: { tenantId, punchInTime: { [Op.gte]: monthStart }, [Op.or]: [{ stationNameId: stationIds }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
        attributes: ['hoursWorked'],
      });
      for (const r of rows) horasMes += Number(r.hoursWorked) || 0;
    } catch { /* optional */ }

    // Coverage-by-turno (today) + general.
    const bands: Array<'diurno' | 'vespertino' | 'nocturno'> = ['diurno', 'vespertino', 'nocturno'];
    const windowByBand = { diurno: '06:00 - 14:00', vespertino: '14:00 - 22:00', nocturno: '22:00 - 06:00' };
    const coberturaTurno = bands.map((b) => {
      const required = requiredBand[b];
      const covered = Math.min(attendedBand[b], required || attendedBand[b]);
      return { key: b, label: bandLabel[b], window: windowByBand[b], required, covered, pct: required ? Math.min(100, Math.round((covered / required) * 100)) : 0 };
    });
    const totReq = coberturaTurno.reduce((a, t) => a + t.required, 0);
    const totCov = coberturaTurno.reduce((a, t) => a + t.covered, 0);
    const generalPct = totReq ? Math.round((totCov / totReq) * 100) : 100;

    // ── Certificaciones próximas a vencer (guard licenses) ───────────────────
    let certificaciones: any[] = [];
    try {
      const sgIds = guardRows.map((g: any) => String(g.id));
      if (sgIds.length) {
        const soon = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
        const lics = await db.guardLicense.findAll({
          where: { tenantId, guardId: sgIds, expiryDate: { [Op.ne]: null, [Op.lte]: soon } },
          include: [{ model: db.licenseType, as: 'licenseType', attributes: ['name'], required: false }],
          order: [['expiryDate', 'ASC']],
          limit: 12,
        });
        const sgById = new Map<string, any>(guardRows.map((g: any) => [String(g.id), g]));
        certificaciones = await Promise.all(lics.map(async (l: any) => {
          const g = sgById.get(String(l.guardId));
          const days = Math.round((+new Date(l.expiryDate) - +now) / (24 * 3600 * 1000));
          return { id: String(l.id), name: g?.fullName || 'Vigilante', role: 'guardia', cert: l.licenseType?.name || 'Licencia', expiresInDays: days, photoUrl: g ? await avatarUrl(g.profileImage) : null };
        }));
      }
    } catch { /* optional */ }

    // ── Ausencias hoy ────────────────────────────────────────────────────────
    const ausenciasHoy: any[] = [];
    const absSeen = new Set<string>();
    try {
      const start = new Date(`${todayStr}T00:00:00`);
      const sgIds = guardRows.map((g: any) => String(g.id));
      const sgById = new Map<string, any>(guardRows.map((g: any) => [String(g.id), g]));
      if (sgIds.length) {
        const exc = await db.attendanceException.findAll({
          where: { tenantId, type: 'no_call_no_show', guardId: sgIds, detectedAt: { [Op.gte]: start } },
          attributes: ['guardId', 'detectedAt'],
        }).catch(() => []);
        for (const e of exc) {
          const g = sgById.get(String(e.guardId));
          if (!g || absSeen.has(String(e.guardId))) continue;
          absSeen.add(String(e.guardId));
          ausenciasHoy.push({ id: String(e.guardId), name: g.fullName || 'Vigilante', turno: null, reason: 'Sin justificación', tone: 'red', photoUrl: await avatarUrl(g.profileImage) });
        }
      }
      // Justified time-off covering today.
      if (guardUserIds.length) {
        const off = await db.timeOffRequest.findAll({
          where: { tenantId, guardId: guardUserIds, status: { [Op.in]: ['approved', 'aprobado', 'Approved'] }, startDate: { [Op.lte]: todayStr }, endDate: { [Op.gte]: todayStr } },
          include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
        }).catch(() => []);
        for (const o of off) {
          const uid = String(o.guardId);
          if (absSeen.has(uid)) continue;
          absSeen.add(uid);
          const u = o.guard;
          const nm = u?.fullName || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'Vigilante';
          ausenciasHoy.push({ id: uid, name: nm, turno: null, reason: o.type || o.reason || 'Permiso', tone: 'orange', photoUrl: null });
        }
      }
    } catch { /* optional */ }

    // ── Filters + pagination (list only) ─────────────────────────────────────
    roster.sort((a, b) => (a._sortName || '').localeCompare(b._sortName || ''));
    const q = String(req.query.q || '').trim().toLowerCase();
    const fRole = String(req.query.role || '');
    const fEstado = String(req.query.estado || '');
    const fTurno = String(req.query.turno || '');
    const fSede = String(req.query.sedeId || '');
    let filtered = roster;
    if (q) filtered = filtered.filter((r) => (r.name || '').toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q) || (r.puesto || '').toLowerCase().includes(q));
    if (fRole) filtered = filtered.filter((r) => r.role === fRole);
    if (fEstado) filtered = filtered.filter((r) => r.estado === fEstado);
    if (fTurno) filtered = filtered.filter((r) => (r.turno?.label || '') === fTurno);
    if (fSede) filtered = filtered.filter((r) => r.sedeId === fSede);

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const perPage = Math.min(50, Math.max(5, parseInt(String(req.query.perPage || '10'), 10) || 10));
    const total = filtered.length;
    const pageItems = filtered.slice((page - 1) * perPage, page * perPage).map((r) => { const { _sortName, ...rest } = r; return rest; });

    return ApiResponseHandler.success(req, res, {
      tz,
      sedes,
      kpis: {
        totalAsignados: totalRoster,
        enTurno, enTurnoPct: pctOf(enTurno),
        fueraTurno, fueraTurnoPct: pctOf(fueraTurno),
        descanso, descansoPct: pctOf(descanso),
        ausentes, ausentesPct: pctOf(ausentes),
        proximosVencer: certificaciones.length,
        cumplimientoCobertura: generalPct,
        metaCobertura,
        horasMes: Math.round(horasMes),
      },
      roleDistribution,
      total,
      personal: pageItems,
      coberturaTurno,
      certificaciones,
      ausenciasHoy,
      page,
      perPage,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
