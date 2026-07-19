import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';

/**
 * Unified activity timeline for a client — merges the guard-generated events that
 * happen at the client's stations/sedes into ONE chronological feed for the CRM
 * client detail: shifts (clock-in/out), incidents, visitor entries/exits, guard
 * task completions, completed rondas, and shift passdowns (relevos).
 *
 *   GET /tenant/:tenantId/client-account/:id/activity?days=&limit=&before=
 *
 * Each source is best-effort (wrapped) so one missing model never breaks the feed.
 * Events are resolved to the client via station.stationOrigin / businessInfo.
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const before = req.query.before ? new Date(String(req.query.before)) : now;
    const from = new Date((before && !Number.isNaN(before.getTime()) ? before.getTime() : now.getTime()) - days * 86400000);
    const to = before && !Number.isNaN(before.getTime()) ? before : now;

    // Client sedes + stations.
    const sedeRows = await db.businessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id', 'companyName'] }).catch(() => []);
    const siteIds = sedeRows.map((s: any) => String(s.id));
    const sedeNameById = new Map<string, string>(sedeRows.map((s: any) => [String(s.id), s.companyName || 'Sede']));
    const stationRows = await db.station.findAll({
      where: { tenantId, [Op.or]: [{ stationOriginId: clientAccountId }, ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
      attributes: ['id', 'stationName', 'postSiteId'],
    }).catch(() => []);
    const stationIds = stationRows.map((s: any) => String(s.id));
    const stationNameById = new Map<string, string>(stationRows.map((s: any) => [String(s.id), s.stationName || 'Estación']));

    const events: any[] = [];
    const push = (e: any) => { if (e && e.at) events.push(e); };
    const stName = (id: any) => (id ? stationNameById.get(String(id)) || null : null);
    const guardName = (g: any) => (g ? (g.fullName || [g.firstName, g.lastName].filter(Boolean).join(' ') || 'Vigilante') : null);
    const inWindow = { [Op.between]: [from, to] };

    if (!stationIds.length && !siteIds.length) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0, days, hasMore: false });
    }

    // 1) Shifts — clock-in / clock-out.
    try {
      const shifts = await db.guardShift.findAll({
        where: {
          tenantId,
          [Op.or]: [
            ...(stationIds.length ? [{ stationNameId: stationIds }] : []),
            ...(siteIds.length ? [{ postSiteId: siteIds }] : []),
          ],
          punchInTime: inWindow,
        },
        include: [{ model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
        order: [['punchInTime', 'DESC']], limit: 200,
      });
      for (const s of shifts) {
        const st = stName(s.stationNameId) || sedeNameById.get(String(s.postSiteId)) || null;
        const g = guardName(s.guardName);
        if (s.punchInTime) push({ id: `shift-in-${s.id}`, type: 'clock_in', at: s.punchInTime, title: 'Entrada de turno', subtitle: st, actor: g, tone: 'green' });
        if (s.punchOutTime) push({ id: `shift-out-${s.id}`, type: 'clock_out', at: s.punchOutTime, title: 'Salida de turno', subtitle: st, actor: g, tone: 'slate' });
      }
    } catch { /* skip */ }

    // 2) Incidents.
    try {
      const linkOr: any[] = [{ clientId: clientAccountId }];
      if (stationIds.length) linkOr.push({ stationId: stationIds });
      if (siteIds.length) linkOr.push({ postSiteId: siteIds });
      const incs = await db.incident.findAll({
        where: { [Op.and]: [{ [Op.or]: [{ tenantId }, { tenantId: null }] }, { [Op.or]: linkOr }, { createdAt: inWindow }] },
        include: [{ model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'], required: false }],
        attributes: ['id', 'title', 'subject', 'priority', 'stationId', 'postSiteId', 'createdAt'],
        order: [['createdAt', 'DESC']], limit: 200, paranoid: true,
      });
      for (const i of incs) {
        const crit = ['alta', 'high', 'critical', 'critica', 'crítica', 'urgent'].includes(String(i.priority || '').toLowerCase());
        push({ id: `inc-${i.id}`, type: 'incident', at: i.createdAt, title: crit ? '🚨 Incidente crítico' : 'Incidente reportado', subtitle: (i.title || i.subject || '') + (stName(i.stationId) ? ` · ${stName(i.stationId)}` : ''), actor: guardName(i.guardName), tone: crit ? 'red' : 'orange' });
      }
    } catch { /* skip */ }

    // 3) Visitors — entries (visitDate) + exits.
    try {
      const vis = await db.visitorLog.findAll({
        where: { tenantId, [Op.or]: [...(stationIds.length ? [{ stationId: stationIds }] : []), ...(siteIds.length ? [{ postSiteId: siteIds }] : [])], visitDate: inWindow },
        attributes: ['id', 'firstName', 'lastName', 'visitDate', 'exitTime', 'stationId', 'postSiteId'],
        order: [['visitDate', 'DESC']], limit: 200,
      }).catch(() => []);
      for (const v of vis) {
        const who = [v.firstName, v.lastName].filter(Boolean).join(' ') || 'Visitante';
        const st = stName(v.stationId) || sedeNameById.get(String(v.postSiteId)) || null;
        push({ id: `vis-in-${v.id}`, type: 'visitor_in', at: v.visitDate, title: 'Visita registrada', subtitle: who + (st ? ` · ${st}` : ''), actor: null, tone: 'blue' });
        if (v.exitTime) push({ id: `vis-out-${v.id}`, type: 'visitor_out', at: v.exitTime, title: 'Visita finalizada', subtitle: who + (st ? ` · ${st}` : ''), actor: null, tone: 'slate' });
      }
    } catch { /* skip */ }

    // 4) Tasks completed by a guard.
    try {
      const tasks = await db.task.findAll({
        where: {
          tenantId,
          completedByGuardId: { [Op.ne]: null },
          updatedAt: inWindow,
          [Op.or]: [{ clientAccountId }, ...(stationIds.length ? [{ stationId: stationIds }] : [])],
        },
        attributes: ['id', 'title', 'description', 'status', 'stationId', 'updatedAt'],
        order: [['updatedAt', 'DESC']], limit: 100,
      }).catch(() => []);
      for (const t of tasks) {
        push({ id: `task-${t.id}`, type: 'task_done', at: t.updatedAt, title: 'Tarea completada', subtitle: (t.title || t.description || 'Tarea') + (stName(t.stationId) ? ` · ${stName(t.stationId)}` : ''), actor: null, tone: 'green' });
      }
    } catch { /* skip */ }

    // 5) Completed rondas.
    try {
      const tours = await db.tourAssignment.findAll({
        where: { tenantId, status: { [Op.in]: ['completed', 'finished', 'complete'] }, updatedAt: inWindow, [Op.or]: [...(stationIds.length ? [{ stationId: stationIds }] : []), ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
        include: [{ model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'], required: false }],
        attributes: ['id', 'stationId', 'postSiteId', 'updatedAt'],
        order: [['updatedAt', 'DESC']], limit: 100,
      }).catch(() => []);
      for (const r of tours) {
        const st = stName(r.stationId) || sedeNameById.get(String(r.postSiteId)) || null;
        push({ id: `ronda-${r.id}`, type: 'ronda_done', at: r.updatedAt, title: 'Ronda completada', subtitle: st, actor: guardName(r.guard), tone: 'primary' });
      }
    } catch { /* skip */ }

    // 6) Shift passdowns (relevos).
    try {
      const pds = await db.shiftPassdown.findAll({
        where: { tenantId, createdAt: inWindow, [Op.or]: [...(stationIds.length ? [{ stationId: stationIds }] : []), ...(siteIds.length ? [{ postSiteId: siteIds }] : [])] },
        attributes: ['id', 'stationId', 'stationName', 'postSiteId', 'outgoingGuardName', 'receivedByName', 'createdAt'],
        order: [['createdAt', 'DESC']], limit: 100,
      }).catch(() => []);
      for (const p of pds) {
        const st = stName(p.stationId) || p.stationName || sedeNameById.get(String(p.postSiteId)) || null;
        push({ id: `pd-${p.id}`, type: 'passdown', at: p.createdAt, title: 'Pase de turno', subtitle: [p.outgoingGuardName, p.receivedByName].filter(Boolean).join(' → ') || st, actor: p.outgoingGuardName || null, tone: 'blue' });
      }
    } catch { /* skip */ }

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const hasMore = events.length > limit;
    const rows = events.slice(0, limit).map((e) => ({ ...e, at: new Date(e.at).toISOString() }));

    await ApiResponseHandler.success(req, res, { rows, count: rows.length, days, hasMore, nextBefore: hasMore ? rows[rows.length - 1].at : null });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
