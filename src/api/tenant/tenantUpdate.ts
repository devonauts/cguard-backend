import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import TenantService from '../../services/tenantService';

export default async (req, res, next) => {
  try {
    /** @openapi { "summary": "Update tenant", "parameters": [ { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } } ], "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "object", "properties": { "name": { "type": "string" }, "url": { "type": "string" }, "taxNumber": { "type": "string" }, "email": { "type": "string" }, "phone": { "type": "string" } } } } } } }, "responses": { "200": { "description": "Tenant updated" }, "400": { "description": "Validation error" } } } */

    if (!req.currentUser || !req.currentUser.id) {
      throw new Error403(req.language);
    }

    // In the case of the Tenant, specific permissions like tenantDestroy and tenantEdit are
    // checked inside the service
    const payload = await new TenantService(req).update(
      req.params.id,
      req.body.data,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
