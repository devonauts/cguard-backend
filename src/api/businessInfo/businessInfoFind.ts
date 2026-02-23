/**
 * @openapi {
 *  "summary": "Find business info",
 *  "description": "Retrieve a business info (post site) by id. Requires authentication.",
 *  "responses": { "200": { "description": "Business info object" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import BusinessInfoService from '../../services/businessInfoService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.businessInfoRead,
    );

    const payload = await new BusinessInfoService(req).findById(
      req.params.id,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
