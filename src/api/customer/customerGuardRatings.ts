/**
 * Client-app guard ratings & feedback (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). A customer rates a guard who is/was on shift at
 * one of THEIR stations; the CRM reads the feedback per guard.
 *
 *   POST /customer/guards/:guardId/rating    { rating (1-5), comment?, stationId?, shiftId? }
 *   GET  /customer/guards/:guardId/ratings   ratings for that guard (scoped)
 *
 * `:guardId` is the securityGuard.id (PK) — the same key guardShift.guardNameId /
 * incident.guardNameId use. For resilience we also accept the linked user id
 * (securityGuard.guardId) and resolve it to the securityGuard PK.
 *
 * Before a rating is accepted, the guard MUST have had at least one shift
 * (guardShift) at one of the customer's stations. CRM notify is best-effort.
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import Error403 from '../../errors/Error403';
import Error404 from '../../errors/Error404';
import { storePlatformEvent } from '../../lib/platformEventStore';
import { TARGET_ROLES } from '../../lib/notificationTemplates';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

/** Stations owned by this client (mirrors customerSafety.resolveCustomerStations). */
async function resolveCustomerStationIds(db: any, tenantId: string, clientAccountId: string): Promise<string[]> {
  const ids = new Set<string>();
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
  for (const s of originStations || []) ids.add(String(s.id));
  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) ids.add(String(s.id));
  }
  return Array.from(ids);
}

/**
 * Resolve the :guardId param to a securityGuard record. Accepts the securityGuard
 * PK (preferred) or the linked user id (securityGuard.guardId). Returns null if no
 * such guard in this tenant.
 */
async function resolveGuard(db: any, tenantId: string, guardIdParam: string): Promise<any | null> {
  const where: any = { ...(tenantId ? { tenantId } : {}), deletedAt: null };
  const guard = await db.securityGuard.findOne({
    where: { ...where, [Op.or]: [{ id: guardIdParam }, { guardId: guardIdParam }] },
    attributes: ['id', 'fullName', 'guardId'],
  });
  return guard || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/guards/:guardId/rating
// ─────────────────────────────────────────────────────────────────────────────
export const customerGuardRatingCreate = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};

    const rating = parseInt(b.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error('rating debe ser un entero entre 1 y 5');
    }
    const comment = b.comment != null ? String(b.comment).trim() : null;

    const guard = await resolveGuard(db, tenantId, String(req.params.guardId));
    if (!guard) throw new Error404();
    const guardPk = String(guard.id);

    const stationIds = await resolveCustomerStationIds(db, tenantId, clientAccountId);
    if (!stationIds.length) throw new Error403();

    // Verify the guard is/was on shift at one of the client's stations.
    // guardShift.guardNameId = securityGuard.id; station FK = stationNameId.
    const shift = await db.guardShift.findOne({
      where: {
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
        guardNameId: guardPk,
        stationNameId: { [Op.in]: stationIds },
      },
      attributes: ['id', 'stationNameId'],
      order: [['punchInTime', 'DESC']],
    });
    if (!shift) throw new Error403();

    // stationId: explicit (must be one of the client's) else the verified shift's.
    let stationId: string | null = b.stationId ? String(b.stationId) : null;
    if (stationId && !stationIds.includes(stationId)) stationId = null;
    if (!stationId) stationId = shift.stationNameId ? String(shift.stationNameId) : null;

    const shiftId = b.shiftId ? String(b.shiftId) : String(shift.id);

    // ONE rating per (client, guard): if this client already rated this guard, UPDATE
    // that row instead of creating a duplicate. A client can re-submit to change their
    // rating/comment, but never stacks multiple reviews for the same guard.
    const existing = await db.guardRating.findOne({
      where: {
        clientAccountId,
        guardId: guardPk,
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
      },
    });
    let ratingRow: any;
    if (existing) {
      await existing.update({
        stationId,
        shiftId,
        rating,
        comment: comment || null,
        updatedById: userId,
      });
      ratingRow = existing;
    } else {
      ratingRow = await db.guardRating.create({
        clientAccountId,
        guardId: guardPk,
        stationId,
        shiftId,
        rating,
        comment: comment || null,
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
    }
    const ratingId = String(ratingRow.id);

    // ── CRM notify (in-app, supervisors). Best-effort.
    try {
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'guard.rated',
        title: `⭐ Calificación de guardia: ${rating}/5`,
        body: `${guard.fullName || 'Guardia'}${comment ? ` — ${comment}` : ''}`,
        payload: { ratingId, guardId: guardPk, rating, comment: comment || null, stationId },
        targetRoles: TARGET_ROLES.SUPERVISORS,
        sourceEntityType: 'guardRating',
        sourceEntityId: ratingId,
      });
    } catch { /* never fail the request on notify */ }

    return ApiResponseHandler.success(req, res, { success: true, ratingId });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/guards/:guardId/ratings
// ─────────────────────────────────────────────────────────────────────────────
export const customerGuardRatingList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const limit = Math.min(parseInt((req.query || {}).limit, 10) || 100, 200);

    const guard = await resolveGuard(db, tenantId, String(req.params.guardId));
    if (!guard) throw new Error404();
    const guardPk = String(guard.id);

    // Scoped to THIS client's ratings of the guard (a client never sees other
    // clients' feedback).
    const rows = await db.guardRating.findAll({
      where: {
        ...(tenantId ? { tenantId } : {}),
        guardId: guardPk,
        clientAccountId,
        deletedAt: null,
      },
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'] }],
      order: [['createdAt', 'DESC']],
      limit,
    });

    const list = (rows || []).map((r: any) => {
      const plain = r.get({ plain: true });
      return {
        id: plain.id,
        rating: plain.rating,
        comment: plain.comment || null,
        stationId: plain.stationId || null,
        stationName: plain.station ? plain.station.stationName : null,
        shiftId: plain.shiftId || null,
        createdAt: plain.createdAt || null,
      };
    });

    const count = list.length;
    const average =
      count > 0 ? Math.round((list.reduce((s, r) => s + (r.rating || 0), 0) / count) * 100) / 100 : null;

    return ApiResponseHandler.success(req, res, {
      guardId: guardPk,
      guardName: guard.fullName || null,
      average,
      count,
      rows: list,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
