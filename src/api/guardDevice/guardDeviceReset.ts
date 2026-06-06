/**
 * POST /api/tenant/:tenantId/guard-device/:id/reset-binding
 *
 * Admin: unbind the guard's devices and clear flags (e.g. they got a new phone),
 * so the next device the guard reports becomes the new bound device.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { resetGuardBinding } from '../../services/guardDeviceService';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.deviceIdInformationEdit,
    );

    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const result = await resetGuardBinding(
      db,
      tenantId,
      req.params.id,
      req.currentUser.id,
    );

    return ApiResponseHandler.success(req, res, { ok: true, ...result });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
