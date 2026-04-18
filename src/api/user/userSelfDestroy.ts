import Error400 from '../../errors/Error400';
import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';
import Roles from '../../security/roles';

export default async (req, res) => {
  try {
    const transaction = SequelizeRepository.getTransaction(req);

    const tenantId = req.params.tenantId;
    const currentUserId = req.currentUser && req.currentUser.id;

    if (!currentUserId) {
      throw new Error400(req.language, 'user.errors.unauthorized');
    }

    // Ensure the tenant in the URL matches the current tenant
    if (String(req.currentTenant && req.currentTenant.id) !== String(tenantId)) {
      throw new Error400(req.language, 'tenant.invalid');
    }

    // Prevent removing the plan owner without transfer
    if (req.currentTenant && req.currentTenant.planUserId && String(req.currentTenant.planUserId) === String(currentUserId)) {
      throw new Error400(req.language, 'user.errors.destroyingPlanUser');
    }

    // Ensure the user exists in this tenant and is a customer
    const tenantUser = await TenantUserRepository.findByTenantAndUser(
      tenantId,
      currentUserId,
      req,
    );

    if (!tenantUser) {
      throw new Error400(req.language, 'user.errors.userNotFound');
    }

    const userRoles = Array.isArray(tenantUser.roles) ? tenantUser.roles : [];
    if (!userRoles.includes(Roles.values.customer)) {
      throw new Error400(req.language, 'user.errors.onlyCustomersCanSelfDelete');
    }

    // Perform tenant-user destroy (removes membership for this tenant)
    await TenantUserRepository.destroy(tenantId, currentUserId, req);

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: currentUserId,
        action: AuditLogRepository.DELETE,
        values: {
          id: currentUserId,
        },
      },
      req,
    );

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
