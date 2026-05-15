import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TimeOffRequestService from '../../services/timeOffRequestService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.timeOffRequestEdit);
    const { status, comment } = req.body?.data ?? {};
    if (!status) {
      return res.status(400).json({ message: 'status is required' });
    }
    const allowed = ['pending', 'approved', 'rejected'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
    }
    const payload = await new TimeOffRequestService(req).updateStatus(req.params.id, { status, comment });
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
