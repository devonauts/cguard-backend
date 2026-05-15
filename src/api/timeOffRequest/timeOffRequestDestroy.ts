import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TimeOffRequestService from '../../services/timeOffRequestService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.timeOffRequestDestroy);
    await new TimeOffRequestService(req).destroy(req.params.id);
    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
