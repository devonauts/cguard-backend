import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryAssignmentService from '../../services/inventoryAssignmentService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.inventoryItemDestroy);
    const ids = req.body?.ids || (req.query?.ids ? (Array.isArray(req.query.ids) ? req.query.ids : [req.query.ids]) : [req.params.id]).filter(Boolean);
    await new InventoryAssignmentService(req).destroyAll(ids);
    await ApiResponseHandler.success(req, res, null);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
