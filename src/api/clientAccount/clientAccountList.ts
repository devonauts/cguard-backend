/**
 * @openapi {
 *  "summary": "List client accounts",
 *  "description": "List client accounts with pagination and filters.",
 *  "responses": { "200": { "description": "Paginated list" } }
 * }
 */
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
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
