/**
 * GET /api/tenant/:tenantId/guard-device/by-guard/:userId
 *
 * Admin/management: the devices a guard has reported, bound device first, with
 * flag state — powers the guard-detail "Dispositivo" tab.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.deviceIdInformationRead,
    );

    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // The guard-detail URL carries the securityGuard record id; devices are keyed
    // by the guard's user id. Resolve securityGuard → user, falling back to
    // treating the param as a user id directly.
    const param = req.params.userId;
    let userId = param;
    try {
      const sg = await db.securityGuard.findOne({
        where: { id: param, tenantId },
        attributes: ['guardId'],
      });
      if (sg && sg.guardId) userId = sg.guardId;
    } catch {
      /* param is already a user id */
    }

    const rows = await db.deviceIdInformation.findAll({
      where: { tenantId, userId },
      order: [
        ['isBound', 'DESC'],
        ['lastSeenAt', 'DESC'],
      ],
    });

    const devices = (rows || []).map((d: any) => ({
      id: d.id,
      deviceId: d.deviceId,
      platform: d.platform,
      model: d.model,
      manufacturer: d.manufacturer,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      isBound: !!d.isBound,
      flagged: !!d.flagged,
      lastSeenAt: d.lastSeenAt,
      lastMismatchAt: d.lastMismatchAt,
      hasPush: !!d.pushToken,
    }));

    return ApiResponseHandler.success(req, res, { rows: devices, count: devices.length });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
