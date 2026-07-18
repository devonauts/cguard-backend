import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';

/**
 * Incidents board for a client: KPIs (total/abiertos/investigación/resueltos +
 * SLA response/resolution), a filterable/paginated list, and filter options.
 * All from the real `incident` model. KPIs cover the date range; table filters
 * (sede/puesto/tipo/estado/prioridad/q) narrow only the list.
 */

const normPriority = (p?: string | null): 'alta' | 'media' | 'baja' | null => {
  const s = (p || '').toLowerCase();
  if (!s) return null;
  if (['alta', 'high', 'urgent', 'critical', 'critica', 'crítica'].includes(s)) return 'alta';
  if (['baja', 'low'].includes(s)) return 'baja';
  if (['media', 'medium', 'normal'].includes(s)) return 'media';
  return 'media';
};
const bucketOf = (status?: string | null, work?: string | null): 'abierto' | 'investigacion' | 'resuelto' => {
  const w = (work || '').toLowerCase();
  if (w === 'resolved' || w === 'closed' || (status || '').toLowerCase() === 'cerrado') return 'resuelto';
  if (w === 'inprogress' || w === 'in_progress' || w === 'investigating' || w === 'investigacion') return 'investigacion';
  return 'abierto';
};
const toNum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();

    // SLA targets from the contract (fallback to sensible defaults).
    let metaResponseMin = 15, metaResolutionDays = 3, metaSlaPct = 95;
    try {
      const cli = await db.clientAccount.findByPk(clientAccountId, { attributes: ['slaResponseMinutes', 'slaUptimeTarget'] });
      if (cli?.slaResponseMinutes != null) metaResponseMin = Number(cli.slaResponseMinutes) || 15;
      if (cli?.slaUptimeTarget != null) metaSlaPct = Number(cli.slaUptimeTarget) || 95;
    } catch { /* defaults */ }

    // Date range (default last 30 days).
    const parseDate = (s: any, fallback: Date) => { const d = s ? new Date(String(s)) : null; return d && !Number.isNaN(d.getTime()) ? d : fallback; };
    const from = parseDate(req.query.from, new Date(now.getTime() - 30 * 24 * 3600 * 1000));
    const to = parseDate(req.query.to, now);
    to.setHours(23, 59, 59, 999);

    // Client sedes + stations.
    const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] });
    const siteIds = sedeRows.map((s: any) => String(s.id));
    const sedes = sedeRows.map((s: any) => ({ id: String(s.id), name: s.companyName || 'Sede' }));
    const sedeNameById = new Map<string, string>(sedeRows.map((s: any) => [String(s.id), s.companyName || 'Sede']));

    const stationRows = await db.station.findAll({
      where: { tenantId, [Op.or]: [{ stationOriginId: clientAccountId }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
      attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'],
    });
    const stationIds = stationRows.map((s: any) => String(s.id));
    const stationMeta = new Map<string, any>(stationRows.map((s: any) => [String(s.id), { name: s.stationName, lat: toNum(s.latitud), lng: toNum(s.longitud), sedeId: s.postSiteId ? String(s.postSiteId) : null }]));
    const puestos = stationRows.map((s: any) => ({ id: String(s.id), name: s.stationName }));

    const linkOr: any[] = [{ clientId: clientAccountId }];
    if (stationIds.length) linkOr.push({ stationId: stationIds });
    if (siteIds.length) linkOr.push({ postSiteId: siteIds });

    // Stable folio: rank ALL client incidents by creation order.
    const allInc = await db.incident.findAll({
      where: { [Op.and]: [{ [Op.or]: [{ tenantId }, { tenantId: null }] }, { [Op.or]: linkOr }] },
      attributes: ['id', 'createdAt'], order: [['createdAt', 'ASC']], paranoid: true,
    }).catch(() => []);
    const folioById = new Map<string, string>();
    allInc.forEach((r: any, i: number) => folioById.set(String(r.id), `INC-${String(i + 1).padStart(5, '0')}`));

    // Incidents within the date range (KPIs + list source).
    const rows = await db.incident.findAll({
      where: {
        [Op.and]: [
          { [Op.or]: [{ tenantId }, { tenantId: null }] },
          { [Op.or]: linkOr },
          { [Op.or]: [{ createdAt: { [Op.between]: [from, to] } }, { date: { [Op.between]: [from, to] } }] },
        ],
      },
      include: [
        { model: db.station, as: 'station', attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'], required: false },
        { model: db.businessInfo, as: 'site', attributes: ['id', 'companyName', 'address', 'city'], required: false },
        { model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'], required: false },
        { model: db.user, as: 'assignedTo', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false },
        { model: db.incidentType, as: 'incidentType', attributes: ['id', 'name'], required: false },
      ],
      order: [['createdAt', 'DESC']],
      limit: 5000,
    }).catch(() => []);

    // Evidence counts (one query).
    const incIds = rows.map((r: any) => String(r.id));
    const evCountById = new Map<string, number>();
    try {
      if (incIds.length) {
        const files = await db.file.findAll({
          where: { belongsTo: db.incident.getTableName(), belongsToColumn: 'imageUrl', belongsToId: incIds, deletedAt: null },
          attributes: ['belongsToId'],
        });
        for (const f of files) { const k = String(f.belongsToId); evCountById.set(k, (evCountById.get(k) || 0) + 1); }
      }
    } catch { /* optional */ }

    const tiposSeen = new Map<string, string>();

    const mapped = rows.map((r: any) => {
      const created = r.createdAt ? new Date(r.createdAt) : (r.date ? new Date(r.date) : now);
      const incidentAt = r.date ? new Date(r.date) : created;
      const bucket = bucketOf(r.status, r.workStatus);
      const pk = normPriority(r.priority);
      const st = r.station || (r.stationId ? stationMeta.get(String(r.stationId)) : null);
      const sedeId = st?.postSiteId ? String(st.postSiteId) : (r.postSiteId ? String(r.postSiteId) : (st?.sedeId || null));
      const sedeName = (sedeId && sedeNameById.get(sedeId)) || (r.site?.companyName) || 'General';
      if (r.incidentType?.id) tiposSeen.set(String(r.incidentType.id), r.incidentType.name);

      // Response time: report → dispatch to supervisor.
      let responseMin: number | null = null;
      if (r.dispatchedAt) responseMin = Math.max(0, Math.round((+new Date(r.dispatchedAt) - +created) / 60000));
      // Resolution time: report → resolved/closed (updatedAt when resolved).
      let resolutionMs: number | null = null;
      if (bucket === 'resuelto' && r.updatedAt) resolutionMs = Math.max(0, +new Date(r.updatedAt) - +created);

      const guard = r.guardName;
      const reportedBy = guard?.fullName
        ? { name: guard.fullName, role: 'Guardia' }
        : (r.assignedTo ? { name: r.assignedTo.fullName || [r.assignedTo.firstName, r.assignedTo.lastName].filter(Boolean).join(' '), role: null } : { name: 'Sistema', role: null });
      const assignedName = r.assignedTo ? (r.assignedTo.fullName || [r.assignedTo.firstName, r.assignedTo.lastName].filter(Boolean).join(' ')) : null;

      return {
        id: String(r.id),
        code: folioById.get(String(r.id)) || `INC-${String(r.id).slice(0, 6).toUpperCase()}`,
        date: incidentAt.toISOString(),
        createdAt: created.toISOString(),
        title: r.title || r.subject || r.incidentType?.name || 'Incidente',
        description: r.description || r.content || '',
        actionsTaken: (r.actionsTaken || '').split(/\r?\n|•|;/).map((s: string) => s.trim()).filter(Boolean),
        causaProbable: (r.subject && r.subject !== r.title) ? r.subject : (r.action || null),
        tipo: r.incidentType?.name || null,
        tipoId: r.incidentType?.id ? String(r.incidentType.id) : null,
        sedeName, sedeId,
        puestoName: st?.stationName || st?.name || null,
        puestoId: r.stationId ? String(r.stationId) : null,
        reportedBy,
        assignedName,
        priority: pk,
        estado: bucket,
        responseMin,
        resolutionMs,
        location: r.location || [r.site?.address, r.site?.city].filter(Boolean).join(', ') || null,
        lat: st?.latitud ?? st?.lat ?? null,
        lng: st?.longitud ?? st?.lng ?? null,
        comments: Array.isArray(r.comments) ? r.comments : (r.comments ? [r.comments] : []),
        evidenceCount: evCountById.get(String(r.id)) || 0,
        dispatchStatus: r.dispatchStatus || null,
      };
    });

    // KPIs over the whole period.
    const total = mapped.length;
    const abiertos = mapped.filter((m) => m.estado === 'abierto').length;
    const investigacion = mapped.filter((m) => m.estado === 'investigacion').length;
    const resueltos = mapped.filter((m) => m.estado === 'resuelto').length;
    const respTimes = mapped.map((m) => m.responseMin).filter((x): x is number => x != null);
    const avgResponseMin = respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null;
    const resTimes = mapped.map((m) => m.resolutionMs).filter((x): x is number => x != null);
    const avgResolutionDays = resTimes.length ? Math.round((resTimes.reduce((a, b) => a + b, 0) / resTimes.length) / (24 * 3600 * 1000) * 10) / 10 : null;
    const slaBase = respTimes.length;
    const slaOk = respTimes.filter((m) => m <= metaResponseMin).length;
    const slaPct = slaBase ? Math.round((slaOk / slaBase) * 100) : 100;
    const pctOf = (n: number) => (total ? Math.round((n / total) * 100) : 0);

    // Table filters + pagination.
    const q = String(req.query.q || '').trim().toLowerCase();
    const fSede = String(req.query.sedeId || '');
    const fPuesto = String(req.query.puestoId || '');
    const fTipo = String(req.query.tipo || '');
    const fEstado = String(req.query.estado || '');
    const fPrio = String(req.query.prioridad || '');
    let filtered = mapped;
    if (q) filtered = filtered.filter((m) => m.code.toLowerCase().includes(q) || (m.title || '').toLowerCase().includes(q) || (m.location || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
    if (fSede) filtered = filtered.filter((m) => m.sedeId === fSede);
    if (fPuesto) filtered = filtered.filter((m) => m.puestoId === fPuesto);
    if (fTipo) filtered = filtered.filter((m) => m.tipoId === fTipo);
    if (fEstado) filtered = filtered.filter((m) => m.estado === fEstado);
    if (fPrio) filtered = filtered.filter((m) => m.priority === fPrio);

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const perPage = Math.min(50, Math.max(5, parseInt(String(req.query.perPage || '10'), 10) || 10));
    const totalFiltered = filtered.length;
    const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

    return ApiResponseHandler.success(req, res, {
      from: from.toISOString(), to: to.toISOString(),
      kpis: {
        total, abiertos, abiertosPct: pctOf(abiertos), investigacion, investigacionPct: pctOf(investigacion),
        resueltos, resueltosPct: pctOf(resueltos), avgResponseMin, metaResponseMin,
        avgResolutionDays, metaResolutionDays, slaPct, metaSlaPct,
      },
      sedes, puestos,
      tipos: [...tiposSeen.entries()].map(([id, name]) => ({ id, name })),
      total: totalFiltered, page, perPage,
      incidents: pageItems,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
