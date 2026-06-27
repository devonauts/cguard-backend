/**
 * @openapi {
 *  "summary": "List users",
 *  "description": "List users with pagination and filters.",
 *  "responses": { "200": { "description": "Paginated list of users" } }
 * }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import UserRepository from '../../database/repositories/userRepository';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userRead,
    );

    // securityGuard users are now excluded inside the repository WHERE (so the
    // `count` returned by findAndCountAll already matches the rows). The previous
    // JS post-filter here ALSO did `payload.count = filteredRows.length`, which
    // corrupted pagination on multi-page result sets — removed.
    const payload = await UserRepository.findAndCountAll(
      req.query,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
