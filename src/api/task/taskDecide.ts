import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TaskApprovalService from '../../services/taskApprovalService';

/**
 * POST /tenant/:tenantId/task/:id/approve   { notes? }
 * POST /tenant/:tenantId/task/:id/reject    { notes }
 * `decision` is fixed by the route (see task/index.ts).
 */
export const makeDecider = (decision: 'approved' | 'rejected') => async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.taskEdit);
    const body = req.body?.data || req.body || {};
    const payload = await new TaskApprovalService(req).decide(req.params.id, {
      status: decision,
      notes: body.notes,
    });
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const taskApprove = makeDecider('approved');
export const taskReject = makeDecider('rejected');
