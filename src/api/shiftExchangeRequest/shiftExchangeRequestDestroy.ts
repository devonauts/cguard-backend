import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftExchangeRequestService from '../../services/shiftExchangeRequestService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.shiftExchangeRequestDestroy);
    await new ShiftExchangeRequestService(req).destroy(req.params.id);
    await ApiResponseHandler.success(req, res, {});
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
