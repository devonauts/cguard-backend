import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import TenantService from '../../services/tenantService';

export default async (req, res, next) => {
  try {
    /** @openapi { "summary": "Create tenant", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "object", "properties": { "name": { "type": "string" }, "url": { "type": "string" }, "taxNumber": { "type": "string" }, "email": { "type": "string" }, "phone": { "type": "string" } }, "required": ["name","url"] } } } } }, "responses": { "200": { "description": "Tenant created" }, "400": { "description": "Validation error" } } } */

    console.log('📝 tenantCreate — incoming request by user:', req.currentUser && req.currentUser.id ? req.currentUser.id : 'NO_CURRENT_USER');
    if (!req.currentUser || !req.currentUser.id) {
      console.warn('⚠️ tenantCreate — request missing currentUser; rejecting');
      throw new Error403(req.language);
    }

    const payload = await new TenantService(req).create(
      req.body.data,
    );
    console.log('📝 tenantCreate — tenant create payload returned id:', payload && payload.id ? payload.id : payload && payload.tenantId ? payload.tenantId : 'NO_TENANT_ID');

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
