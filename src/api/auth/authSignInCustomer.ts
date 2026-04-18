/** @openapi { "summary": "Sign in (customer app)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "invitationToken": { "type": "string" }, "tenantId": { "type": "string" } }, "required": ["email","password"] } } } }, "responses": { "200": { "description": "Auth payload (customer trimmed tenant)" }, "401": { "description": "Invalid credentials" } } } */

import ApiResponseHandler from '../apiResponseHandler'
import AuthService from '../../services/auth/authService'
import Error400 from '../../errors/Error400'
import BannerSuperiorAppService from '../../services/bannerSuperiorAppService'
import CertificationService from '../../services/certificationService'
import ServiceService from '../../services/serviceService'
import Roles from '../../security/roles'

export default async (req: any, res: any) => {
  try {
    // Reuse signin logic to authenticate and obtain token + user
    const payload: any = await AuthService.signin(
      req.body.email,
      req.body.password,
      req.body.invitationToken,
      req.body.tenantId,
      req,
    )

    // payload: { token, user }
    if (payload && payload.user && payload.user.tenant) {
      const tenantEntry: any = payload.user.tenant;
      const tenantId = tenantEntry.tenantId || (tenantEntry.tenant && tenantEntry.tenant.id) || null;

      // Build a trimmed tenant object (always an object to simplify assignment)
      const tenantData: any = tenantEntry.tenant || {};
      // Ensure sensitive/unused tenant fields are removed from the customer payload
      try {
        delete tenantData.url;
        delete tenantData.plan;
        delete tenantData.logoId;
      } catch (e) {
        // ignore
      }
      const trimmed: any = {
        id: tenantData.id || null,
        name: tenantData.name || null,
      };

      // Validate that the tenant entry includes the `customer` role
      const roles = Array.isArray(tenantEntry.roles) ? tenantEntry.roles : [];
      if (!roles.includes(Roles.values.customer)) {
        throw new Error400(req.language, 'auth.roleNotCustomer');
      }

      // If role includes `customer`, fetch compact asset ids
      if (tenantId && roles.includes(Roles.values.customer)) {
        // Attach currentTenant to req so services operate in tenant scope
        req.currentTenant = { id: tenantId };

        try {
          const banners = await new BannerSuperiorAppService(req).findAndCountAll({ filter: {}, limit: 0 });
          const certs = await new CertificationService(req).findAndCountAll({ filter: {}, limit: 0 });
          const services = await new ServiceService(req).findAndCountAll({ filter: {}, limit: 0 });
          trimmed.bannerIds = Array.isArray(banners.rows) ? banners.rows.map((r: any) => r.id) : [];
          trimmed.certificationIds = Array.isArray(certs.rows) ? certs.rows.map((r: any) => r.id) : [];
          trimmed.serviceIds = Array.isArray(services.rows) ? services.rows.map((r: any) => r.id) : [];
        } catch (err) {
          console.warn('authSignInCustomer: could not load tenant assets', (err && (err as any).message) ? (err as any).message : err);
          trimmed.bannerIds = trimmed.bannerIds || [];
          trimmed.certificationIds = trimmed.certificationIds || [];
          trimmed.serviceIds = trimmed.serviceIds || [];
        }
      }

      // Replace tenant payload with trimmed version (preserve roles/permissions/status)
      payload.user.tenant = {
        tenantId: tenantEntry.tenantId,
        tenant: trimmed,
        roles: tenantEntry.roles || [],
        permissions: tenantEntry.permissions || [],
        assignedClients: tenantEntry.assignedClients || [],
        assignedPostSites: tenantEntry.assignedPostSites || [],
        status: tenantEntry.status || null,
      };
    }

    return ApiResponseHandler.success(req, res, payload)
  } catch (error) {
    return ApiResponseHandler.error(req, res, error)
  }
}
