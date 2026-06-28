/**
 * Customer-app visitor PRE-AUTHORIZATION endpoints (Mi Seguridad). Auth = the
 * customer JWT (currentUser.clientAccountId). The customer pre-registers an
 * expected visitor and receives a `qrToken` / `qrPayload` that the app renders
 * locally as a QR image. At the gate the guard app scans the QR and validates it
 * via /tenant/:tenantId/visitor-preauth/scan (see workerVisitorPreAuthScan.ts).
 *
 *   POST /customer/visitor-preauth            create a pre-auth → { id, qrToken, qrPayload }
 *   GET  /customer/visitor-preauth            list the customer's pre-auths (scoped)
 *   POST /customer/visitor-preauth/:id/revoke revoke an active pre-auth
 *
 * Every query is strictly scoped to the customer's own stations, reusing
 * resolveCustomerStations from customerSafety.ts.
 */
import crypto from 'crypto';
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';

/**
 * The set of stationIds the customer is allowed to touch — a local copy of
 * customerSafety.ts's resolveCustomerStations (that one is module-local and not
 * exported). A station belongs to a customer if EITHER it is under one of the
 * customer's post-sites (businessInfo.clientAccountId → station.postSiteId) OR it
 * is directly owned via station.stationOriginId.
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
        attributes: ['id', 'stationName', 'latitud', 'longitud', 'postSiteId'],
      })
    : [];

  return { stationIds: ids, stations };
}

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

const parseDate = (v: any): Date | null => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const serialize = (p: any) => ({
  id: p.id,
  visitorFirstName: p.visitorFirstName || null,
  visitorLastName: p.visitorLastName || null,
  visitorIdNumber: p.visitorIdNumber || null,
  reason: p.reason || null,
  company: p.company || null,
  vehiclePlate: p.vehiclePlate || null,
  stationId: p.stationId || null,
  postSiteId: p.postSiteId || null,
  validFrom: p.validFrom || null,
  validUntil: p.validUntil || null,
  qrToken: p.qrToken,
  qrPayload: p.qrToken,
  status: p.status,
  usedAt: p.usedAt || null,
  createdVisitorLogId: p.createdVisitorLogId || null,
  createdAt: p.createdAt || null,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/visitor-preauth — create a pre-authorization (QR pass)
// ─────────────────────────────────────────────────────────────────────────────
export const customerVisitorPreAuthCreate = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};

    const visitorFirstName = String(b.visitorFirstName || '').trim();
    const visitorLastName = String(b.visitorLastName || '').trim();
    if (!visitorFirstName) {
      throw new Error400(req.language, 'validation.required');
    }

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    // Resolve the target station: explicit stationId (must belong to the customer),
    // else the customer's first station. Mirrors customerSos resolution.
    let stationId: string | null = null;
    if (b.stationId && stationById.has(String(b.stationId))) {
      stationId = String(b.stationId);
    }
    if (!stationId && stationIds.length) stationId = stationIds[0];
    const station = stationId ? stationById.get(stationId) : null;
    const postSiteId = station ? (station.postSiteId || null) : null;

    const validFrom = parseDate(b.validFrom) || new Date();
    // Default window: 24h from validFrom when the customer doesn't supply validUntil.
    const validUntil = parseDate(b.validUntil) || new Date(validFrom.getTime() + 24 * 60 * 60 * 1000);

    const qrToken = crypto.randomUUID();

    const created = await db.visitorPreAuthorization.create({
      clientAccountId,
      stationId,
      postSiteId,
      visitorFirstName,
      visitorLastName: visitorLastName || null,
      visitorIdNumber: b.visitorIdNumber ? String(b.visitorIdNumber).trim() : null,
      reason: b.reason ? String(b.reason).trim() : null,
      company: b.company ? String(b.company).trim() : null,
      vehiclePlate: b.vehiclePlate ? String(b.vehiclePlate).trim() : null,
      validFrom,
      validUntil,
      qrToken,
      status: 'active',
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    return ApiResponseHandler.success(req, res, {
      success: true,
      id: created.id,
      qrToken,
      // The exact string the app encodes into the QR image. Kept identical to
      // qrToken so the guard scan (which sends the decoded payload verbatim) and
      // the customer app agree on a single opaque value.
      qrPayload: qrToken,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/visitor-preauth — list the customer's pre-authorizations
// ─────────────────────────────────────────────────────────────────────────────
export const customerVisitorPreAuthList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);

    const where: any = {
      ...(tenantId ? { tenantId } : {}),
      clientAccountId,
      deletedAt: null,
    };
    if (q.status) where.status = String(q.status);

    const rows = await db.visitorPreAuthorization.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    });

    // Lazily reflect expiry in the response (status flips to 'expired' on the next
    // scan; here we just present it accurately without a write).
    const now = Date.now();
    const out = (rows || []).map((p: any) => {
      const s = serialize(p);
      if (
        s.status === 'active' &&
        p.validUntil &&
        new Date(p.validUntil).getTime() < now
      ) {
        s.status = 'expired';
      }
      return s;
    });

    return ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/visitor-preauth/:id/revoke — revoke an active pre-authorization
// ─────────────────────────────────────────────────────────────────────────────
export const customerVisitorPreAuthRevoke = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const id = req.params.id;

    const preAuth = await db.visitorPreAuthorization.findOne({
      where: {
        id,
        ...(tenantId ? { tenantId } : {}),
        clientAccountId,
        deletedAt: null,
      },
    });
    if (!preAuth) throw new Error404();

    if (preAuth.status === 'used') {
      // Already consumed at the gate — can't revoke a completed visit.
      throw new Error400(req.language, 'validation.invalidState');
    }

    preAuth.status = 'revoked';
    preAuth.updatedById = userId;
    await preAuth.save();

    return ApiResponseHandler.success(req, res, { success: true, id, status: 'revoked' });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
