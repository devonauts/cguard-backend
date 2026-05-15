import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ShiftExchangeRequestService from '../../services/shiftExchangeRequestService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.shiftExchangeRequestRead);
    const payload = await new ShiftExchangeRequestService(req).findAndCountAll(req.query);
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
