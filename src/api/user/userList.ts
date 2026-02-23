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

    const payload = await UserRepository.findAndCountAll(
      req.query,
      req,
    );

    // Exclude users that have the `securityGuard` role in the current tenant
    try {
      const tenantId = req.params.tenantId;
      if (payload && Array.isArray(payload.rows)) {
        const filteredRows = payload.rows.filter((user) => {
          try {
            if (!user) return true;
            const roles = Array.isArray(user.roles)
              ? user.roles
              : (typeof user.roles === 'string' ? JSON.parse(user.roles) : []);
            return !roles.includes('securityGuard');
          } catch (e) {
            return true;
          }
        });

        payload.rows = filteredRows;
        payload.count = filteredRows.length;
      }
    } catch (e) {
      // ignore filtering errors and return original payload
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
