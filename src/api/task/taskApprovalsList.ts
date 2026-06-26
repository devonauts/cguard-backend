import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TaskApprovalService from '../../services/taskApprovalService';

// GET /tenant/:tenantId/task/approvals?status=pending_approval
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.taskEdit);
    const payload = await new TaskApprovalService(req).listByStatus(req.query || {});
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
