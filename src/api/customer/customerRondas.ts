/**
 * Client-app RONDA (patrol) HISTORY endpoint. Auth = the customer JWT
 * (currentUser.clientAccountId). Read-only: the customer never creates rondas.
 *
 *   GET /customer/rondas?stationId=&limit=&offset=
 *
 * New rondas are recorded in the siteTour system (tourAssignment + tagScan +
 * siteTour + siteTourTag), NOT the legacy /tenant/:t/patrol table the client app
 * used to read — which is why client ronda history showed empty. This exposes the
 * siteTour-based history to the customer scope, strictly restricted to the
 * customer's own stations.
 *
 * Mirrors the admin "Historial de Rondas" query in
 * src/api/siteTour.ts → GET /tenant/:tenantId/station/:stationId/ronda-history:
 * tourAssignment (where tenantId+stationId) including siteTour, guard and scans,
 * plus per-tour total checkpoint counts + checkpoint (tag) names. Station scoping
 * uses the SAME resolveCustomerStations helper as the other customer-safety routes.
 */
import { Op } from 'sequelize';
import { getConfig } from '../../config';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    clientAccountId,
  };
};

/**
 * The set of stationIds the customer is allowed to touch. A station belongs to a
 * customer if EITHER it is under one of the customer's post-sites
 * (businessInfo.clientAccountId → station.postSiteId) OR it is directly owned via
 * station.stationOriginId. Mirrors customerSafety.resolveCustomerStations.
 * Returns { stationIds, stations } where stations carry id/name.
 */
async function resolveCustomerStations(db: any, tenantId: string, clientAccountId: string) {
  const stationIds = new Set<string>();

  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) stationIds.add(String(s.id));

  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) stationIds.add(String(s.id));
  }

  const ids = Array.from(stationIds);
  const stations = ids.length
    ? await db.station.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'stationName'],
      })
    : [];

  return { stationIds: ids, stations };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/rondas — siteTour-based ronda history for the customer's stations
// ─────────────────────────────────────────────────────────────────────────────
export const customerRondasList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    // Resolve the station scope. If an explicit ?stationId is passed it MUST be one
    // of the customer's own stations — otherwise return empty (don't leak/allow
    // other clients' stations). With no filter, scope to all the customer's stations.
    let scopedStationIds = stationIds;
    if (q.stationId != null && String(q.stationId).trim() !== '') {
      const requested = String(q.stationId);
      if (!stationById.has(requested)) {
        return ApiResponseHandler.success(req, res, { count: 0, rows: [] });
      }
      scopedStationIds = [requested];
    }

    if (!scopedStationIds.length) {
      return ApiResponseHandler.success(req, res, { count: 0, rows: [] });
    }

    const where: any = {
      ...(tenantId ? { tenantId } : {}),
      stationId: { [Op.in]: scopedStationIds },
    };

    const count = await db.tourAssignment.count({ where });
    const rows = await db.tourAssignment.findAll({
      where,
      include: [
        { model: db.siteTour, as: 'siteTour', attributes: ['id', 'name'], required: false },
        { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'], required: false },
        {
          model: db.tagScan,
          as: 'scans',
          attributes: ['id', 'siteTourTagId', 'scannedAt', 'validLocation', 'distanceMeters', 'scannedData'],
          required: false,
        },
      ],
      order: [['startAt', 'DESC'], ['createdAt', 'DESC']],
      limit,
      offset,
    });

    // Total checkpoints per tour (for progress) + checkpoint names (for scans).
    const tourIds = Array.from(
      new Set((rows || []).map((r: any) => r.siteTourId).filter(Boolean)),
    );
    const tagCountByTour: Record<string, number> = {};
    if (tourIds.length) {
      const counts = await db.siteTourTag.findAll({
        where: { siteTourId: tourIds },
        attributes: ['siteTourId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'cnt']],
        group: ['siteTourId'],
        raw: true,
      });
      counts.forEach((c: any) => { tagCountByTour[c.siteTourId] = Number(c.cnt); });
    }
    const tagIds = Array.from(
      new Set(
        (rows || [])
          .flatMap((r: any) => (r.scans || []).map((s: any) => s.siteTourTagId))
          .filter(Boolean),
      ),
    );
    const tagNameById: Record<string, string> = {};
    if (tagIds.length) {
      const tags = await db.siteTourTag.findAll({
        where: { id: tagIds },
        attributes: ['id', 'name'],
        raw: true,
      });
      tags.forEach((t: any) => { tagNameById[t.id] = t.name; });
    }

    // The guard's per-checkpoint NOTE + PHOTO are stored in tagScan.scannedData.extra
    // ({ notes, photoFileToken, checkpointName }). Build a signed download URL for the
    // photo so the client patrol detail can show the proof (image + note).
    const backendBase = String((getConfig() as any).BACKEND_URL || '').replace(/\/+$/, '');
    const fileDownloadPath = backendBase.endsWith('/api') ? '/file/download' : '/api/file/download';
    const photoUrlFromToken = (token: any): string | null =>
      token ? `${backendBase}${fileDownloadPath}?fileToken=${encodeURIComponent(String(token))}` : null;
    const parseScanExtra = (scannedData: any): any => {
      if (!scannedData) return {};
      try {
        const obj = typeof scannedData === 'string' ? JSON.parse(scannedData) : scannedData;
        return (obj && obj.extra) || {};
      } catch { return {}; }
    };

    const out = (rows || []).map((r: any) => {
      const p = r.get ? r.get({ plain: true }) : r;
      const station = stationById.get(String(p.stationId)) || {};
      const scans = (p.scans || [])
        .map((s: any) => {
          const extra = parseScanExtra(s.scannedData);
          const note = (extra.notes && String(extra.notes).trim()) || null;
          return {
            id: s.id,
            checkpoint: tagNameById[s.siteTourTagId] || extra.checkpointName || '—',
            scannedAt: s.scannedAt,
            validLocation: s.validLocation,
            note,
            photoUrl: photoUrlFromToken(extra.photoFileToken),
          };
        })
        .sort(
          (a: any, b: any) =>
            new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime(),
        );
      return {
        id: p.id,
        tourName: (p.siteTour && p.siteTour.name) || 'Ronda',
        stationId: p.stationId || null,
        stationName: station.stationName || null,
        guardName: (p.guard && p.guard.fullName) || '—',
        startAt: p.startAt,
        endAt: p.endAt,
        status: p.status,
        totalCheckpoints: tagCountByTour[p.siteTourId] || 0,
        scannedCount: scans.length,
        scans,
      };
    });

    return ApiResponseHandler.success(req, res, { count, rows: out });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** GET /customer/rondas/:assignmentId — full detail, scoped to the client's stations. */
export const customerRondaDetail = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const { stationIds } = await resolveCustomerStations(db, tenantId, clientAccountId);
    if (!stationIds.length) { const e: any = new Error('No encontrado'); e.code = 404; throw e; }
    const { buildRondaDetail } = require('../../services/rondaDetailService');
    const detail = await buildRondaDetail(db, tenantId, req.params.assignmentId, { stationIds });
    if (!detail) { const e: any = new Error('No encontrado'); e.code = 404; throw e; }
    await ApiResponseHandler.success(req, res, detail);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default customerRondasList;
