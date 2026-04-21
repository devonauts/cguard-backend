import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryHistoryService from '../../services/inventoryHistoryService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.inventoryHistoryRead,
    );

    // Ensure filter object exists and scope to patrolId
    const q = { ...(req.query || {}) };
    q.filter = q.filter || {};
    q.filter.patrol = req.params.patrolId;

    const payload = await new InventoryHistoryService(
      req,
    ).findAndCountAll(q);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
