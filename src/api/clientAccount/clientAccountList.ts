import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountService from '../../services/clientAccountService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientAccountRead,
    );

    console.log('📥 [ClientAccountList] query params:', JSON.stringify(req.query));
    const payload = await new ClientAccountService(
      req,
    ).findAndCountAll(req.query);
    console.log('📤 [ClientAccountList] rows:', payload?.rows?.length, 'count:', payload?.count);
    console.log('📤 [ClientAccountList] first 3 names:', payload?.rows?.slice(0, 3).map(r => r.name));

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
