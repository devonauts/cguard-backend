import ApiResponseHandler from '../apiResponseHandler';
import SecurityGuardService from '../../services/securityGuardService';
import Error404 from '../../errors/Error404';
import Error403 from '../../errors/Error403';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';

export default async (req, res, next) => {
  try {
    // Allow using invitation token in body to authenticate (convenience for public flow)
    const token = req.body && (req.body.token || req.body.invitationToken);
    if (!req.currentUser && token) {
      try {
        const tenantUser = await TenantUserRepository.findByInvitationToken(
          token,
          req,
        );

        if (tenantUser && tenantUser.user) {
          // Temporarily set currentUser and currentTenant for this request
          req.currentUser = tenantUser.user;
          req.currentTenant = tenantUser.tenant || req.currentTenant;
        }
      } catch (err) {
        // ignore and fallback to permission error below
      }
    }

    // Require authentication
    if (!req.currentUser) {
      throw new Error403();
    }

    // Find the securityGuard record belonging to the current user in this tenant
    const service = new SecurityGuardService(req);
    const result = await service.findAndCountAll({ filter: { guard: req.currentUser.id }, limit: 1, offset: 0 });

    if (!result || !result.count || result.count === 0) {
      throw new Error404();
    }

    const id = result.rows[0].id;

    // Update using existing service logic (validation + repository)
    const payload = await service.update(id, req.body.data || {});

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
