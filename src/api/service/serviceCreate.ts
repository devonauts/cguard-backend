import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
/**
 * @openapi {
 *  "summary": "Create service",
 *  "description": "Creates a new service entry.",
 *  "requestBody": { "content": { "application/json": { "schema": { "type": "object" } } } },
 *  "responses": { "200": { "description": "Created" } }
 * }
 */
import ServiceService from '../../services/serviceService';

export default async (req, res, next) => {
  try {
    // Ensure a tenant id is present on the request to avoid null tenantId
    if (!req.currentTenant) {
      const tenantIdFromParams = req.params && req.params.tenantId;
      const tenantIdFromHeader = req.headers && (req.headers['x-tenant-id'] || req.headers['X-Tenant-Id']);
      const tenantId = tenantIdFromParams || tenantIdFromHeader || null;
      if (tenantId) {
        req.currentTenant = { id: tenantId };
      }
    }
    new PermissionChecker(req).validateHas(
      Permissions.values.serviceCreate,
    );

    const payload = await new ServiceService(req).create(
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
