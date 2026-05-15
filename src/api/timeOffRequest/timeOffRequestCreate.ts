import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TimeOffRequestService from '../../services/timeOffRequestService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.timeOffRequestCreate);
    const payload = await new TimeOffRequestService(req).create(req.body.data);
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
