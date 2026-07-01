/**
 * Client-app RECENT ACTIVITY feed. Auth = the customer JWT (currentUser.clientAccountId).
 * Read-only. Unifies everything that happens at the client's stations (sitios de
 * vigilancia) into one time-sorted feed:
 *   - clock_in / clock_out   guard arrived at / left the post (guardShift punches)
 *   - ronda                  a patrol/ronda completed (tourAssignment)
 *   - incident               an incident reported (incident)
 *   - visit                  a visitor registered (visitorLog)
 *
 *   GET /customer/activity?limit=&days=
 *
 * Each source is queried defensively (a failure in one never empties the whole feed).
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return { db: req.database, tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id), clientAccountId };
};

/** Stations the customer owns — origin stations + post-site stations. */
async function resolveCustomerStations(db: any, tenantId: string, clientAccountId: string) {
  const stationIds = new Set<string>();
  const [originStations, postSites] = await Promise.all([
    db.station.findAll({ where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null }, attributes: ['id'] }),
    db.businessInfo.findAll({ where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null }, attributes: ['id'] }),
  ]);
  for (const s of originStations || []) stationIds.add(String(s.id));
  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({ where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null }, attributes: ['id'] });
    for (const s of psStations || []) stationIds.add(String(s.id));
  }
  const ids = Array.from(stationIds);
  const stations = ids.length
    ? await db.station.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'stationName'] })
    : [];
  const nameById = new Map<string, string>();
  for (const s of stations) nameById.set(String(s.id), s.stationName || '');
  return { stationIds: ids, nameById };
}

export const customerActivityList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 40, 1), 100);
    const days = Math.min(Math.max(parseInt(q.days, 10) || 30, 1), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { stationIds, nameById } = await resolveCustomerStations(db, tenantId, clientAccountId);
    if (!stationIds.length) return ApiResponseHandler.success(req, res, { rows: [], count: 0 });

    const perSource = 25;
    const sIn = { [Op.in]: stationIds };
    const events: any[] = [];
    const push = (e: any) => { if (e && e.at) events.push(e); };
    const stName = (id: any) => nameById.get(String(id)) || null;

    // ── Guard clock-in / clock-out (coverage) ──────────────────────────────────
    try {
      const shifts = await db.guardShift.findAll({
        where: { ...(tenantId ? { tenantId } : {}), stationNameId: sIn, punchInTime: { [Op.gte]: since } },
        include: [{ model: db.securityGuard, as: 'guardName', attributes: ['fullName'], required: false }],
        attributes: ['id', 'stationNameId', 'punchInTime', 'punchOutTime'],
        order: [['punchInTime', 'DESC']],
        limit: perSource,
      });
      for (const s of shifts) {
        const p = s.get({ plain: true });
        const guard = (p.guardName && p.guardName.fullName) || 'Guardia';
        push({ id: `ci-${p.id}`, type: 'clock_in', title: `${guard}`, subtitle: 'Entrada de guardia', at: p.punchInTime, stationName: stName(p.stationNameId) });
        if (p.punchOutTime && new Date(p.punchOutTime) >= since) {
          push({ id: `co-${p.id}`, type: 'clock_out', title: `${guard}`, subtitle: 'Salida de guardia', at: p.punchOutTime, stationName: stName(p.stationNameId) });
        }
      }
    } catch (e: any) { console.warn('[customerActivity] shifts failed:', e?.message); }

    // ── Rondas / patrols completed ─────────────────────────────────────────────
    try {
      const tours = await db.tourAssignment.findAll({
        where: { ...(tenantId ? { tenantId } : {}), stationId: sIn, [Op.or]: [{ endAt: { [Op.gte]: since } }, { startAt: { [Op.gte]: since } }] },
        include: [
          { model: db.siteTour, as: 'siteTour', attributes: ['name'], required: false },
          { model: db.securityGuard, as: 'guard', attributes: ['fullName'], required: false },
        ],
        attributes: ['id', 'stationId', 'startAt', 'endAt', 'status'],
        order: [['startAt', 'DESC']],
        limit: perSource,
      });
      for (const t of tours) {
        const p = t.get({ plain: true });
        const tour = (p.siteTour && p.siteTour.name) || 'Ronda';
        const guard = (p.guard && p.guard.fullName) || 'Guardia';
        push({ id: `rn-${p.id}`, type: 'ronda', title: tour, subtitle: `${guard} · ${p.status || 'ronda'}`, at: p.endAt || p.startAt, stationName: stName(p.stationId) });
      }
    } catch (e: any) { console.warn('[customerActivity] rondas failed:', e?.message); }

    // ── Incidents ──────────────────────────────────────────────────────────────
    try {
      const incidents = await db.incident.findAll({
        where: { ...(tenantId ? { tenantId } : {}), stationId: sIn, deletedAt: null, [Op.or]: [{ createdAt: { [Op.gte]: since } }, { date: { [Op.gte]: since } }] },
        attributes: ['id', 'title', 'description', 'content', 'priority', 'stationId', 'date', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit: perSource,
      });
      for (const i of incidents) {
        const p = i.get({ plain: true });
        push({ id: `in-${p.id}`, type: 'incident', title: p.title || 'Incidente', subtitle: (p.description || p.content || '').toString().slice(0, 120) || 'Incidente reportado', at: p.createdAt || p.date, stationName: stName(p.stationId), priority: p.priority || null });
      }
    } catch (e: any) { console.warn('[customerActivity] incidents failed:', e?.message); }

    // ── Visitor registrations ──────────────────────────────────────────────────
    try {
      const visits = await db.visitorLog.findAll({
        where: { ...(tenantId ? { tenantId } : {}), stationId: sIn, createdAt: { [Op.gte]: since } },
        attributes: ['id', 'firstName', 'lastName', 'stationId', 'exitTime', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit: perSource,
      });
      for (const v of visits) {
        const p = v.get({ plain: true });
        const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || 'Visitante';
        push({ id: `vi-${p.id}`, type: 'visit', title: name, subtitle: p.exitTime ? 'Visita finalizada' : 'Visitante registrado', at: p.createdAt, stationName: stName(p.stationId) });
      }
    } catch (e: any) { console.warn('[customerActivity] visits failed:', e?.message); }

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const rows = events.slice(0, limit);
    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default customerActivityList;
