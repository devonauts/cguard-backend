import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * WORKER/guard scan of a visitor pre-authorization QR.
 *
 *   POST /tenant/:tenantId/visitor-preauth/scan   body { qrToken }
 *
 * The guard app reads the QR (an opaque qrToken) and POSTs it here. We validate:
 *   - the token exists for this tenant and is still 'active'
 *   - now is within validFrom..validUntil (else mark 'expired')
 *   - the pre-auth's station belongs to this tenant
 * On success we mark the pre-auth 'used' (+ usedAt + usedByGuardId) AND materialise
 * a real `visitorLog` row from the pre-auth data so the visit appears in Control de
 * Visitas, storing its id in createdVisitorLogId.
 *
 * Gated by the visitorLogCreate permission — every guard role already has it (it's
 * the permission they use to check visitors in), so no new permission is needed.
 *
 * Returns { valid: true, visitor, visitorLogId } or { valid: false, reason }.
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.visitorLogCreate);

    const db = req.database;
    const currentTenant = req.currentTenant;
    const currentUser = req.currentUser;
    const tenantId = currentTenant?.id;
    const b = req.body?.data || req.body || {};
    const qrToken = String(b.qrToken || '').trim();

    if (!qrToken) {
      return ApiResponseHandler.success(req, res, { valid: false, reason: 'missing_token' });
    }

    const preAuth = await db.visitorPreAuthorization.findOne({
      where: {
        qrToken,
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
      },
    });

    if (!preAuth) {
      return ApiResponseHandler.success(req, res, { valid: false, reason: 'not_found' });
    }

    if (preAuth.status === 'used') {
      return ApiResponseHandler.success(req, res, {
        valid: false,
        reason: 'already_used',
        usedAt: preAuth.usedAt || null,
        visitorLogId: preAuth.createdVisitorLogId || null,
      });
    }
    if (preAuth.status === 'revoked') {
      return ApiResponseHandler.success(req, res, { valid: false, reason: 'revoked' });
    }
    if (preAuth.status !== 'active') {
      return ApiResponseHandler.success(req, res, { valid: false, reason: preAuth.status });
    }

    const now = Date.now();
    if (preAuth.validFrom && new Date(preAuth.validFrom).getTime() > now) {
      return ApiResponseHandler.success(req, res, {
        valid: false,
        reason: 'not_yet_valid',
        validFrom: preAuth.validFrom,
      });
    }
    if (preAuth.validUntil && new Date(preAuth.validUntil).getTime() < now) {
      // Reflect expiry so future scans short-circuit.
      preAuth.status = 'expired';
      preAuth.updatedById = currentUser?.id || null;
      await preAuth.save();
      return ApiResponseHandler.success(req, res, {
        valid: false,
        reason: 'expired',
        validUntil: preAuth.validUntil,
      });
    }

    // Resolve the pre-auth's station and confirm it belongs to this tenant. If the
    // pre-auth has no station (legacy / unresolved), the visitorLog is created
    // station-less (allowed — stationId is nullable on visitorLog).
    let stationId: string | null = preAuth.stationId ? String(preAuth.stationId) : null;
    let stationName: string | null = null;
    let postSiteId: string | null = preAuth.postSiteId ? String(preAuth.postSiteId) : null;
    if (stationId) {
      const station = await db.station.findOne({
        where: { id: stationId, ...(tenantId ? { tenantId } : {}), deletedAt: null },
        attributes: ['id', 'stationName', 'postSiteId'],
      });
      if (!station) {
        return ApiResponseHandler.success(req, res, { valid: false, reason: 'station_mismatch' });
      }
      stationName = station.stationName || null;
      if (!postSiteId && station.postSiteId) postSiteId = String(station.postSiteId);
    }

    // ── Materialise the real visitorLog from the pre-auth data. Columns mirror the
    // visitorLog model: firstName/lastName/idNumber/reason/company/vehiclePlate/
    // visitDate/stationId/stationName/postSiteId/clientId. visitDate = now (arrival).
    const visitorLog = await db.visitorLog.create({
      visitDate: new Date(),
      firstName: preAuth.visitorFirstName || null,
      lastName: preAuth.visitorLastName || null,
      idNumber: preAuth.visitorIdNumber || null,
      reason: preAuth.reason || null,
      company: preAuth.company || null,
      vehiclePlate: preAuth.vehiclePlate || null,
      numPeople: 1,
      stationId,
      stationName,
      postSiteId,
      clientId: preAuth.clientAccountId || null,
      tenantId,
      createdById: currentUser?.id || null,
      updatedById: currentUser?.id || null,
    });

    // ── Mark the pre-auth consumed.
    preAuth.status = 'used';
    preAuth.usedAt = new Date();
    preAuth.usedByGuardId = currentUser?.id || null;
    preAuth.createdVisitorLogId = visitorLog.id;
    preAuth.updatedById = currentUser?.id || null;
    await preAuth.save();

    return ApiResponseHandler.success(req, res, {
      valid: true,
      visitorLogId: visitorLog.id,
      visitor: {
        firstName: preAuth.visitorFirstName || null,
        lastName: preAuth.visitorLastName || null,
        idNumber: preAuth.visitorIdNumber || null,
        reason: preAuth.reason || null,
        company: preAuth.company || null,
        vehiclePlate: preAuth.vehiclePlate || null,
        stationId,
        stationName,
        validFrom: preAuth.validFrom || null,
        validUntil: preAuth.validUntil || null,
      },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
