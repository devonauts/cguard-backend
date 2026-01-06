import PermissionChecker from '../../services/user/permissionChecker';
import Error400 from '../../errors/Error400';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import AuditLogRepository from '../../database/repositories/auditLogRepository';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userEdit,
    );

    const transaction = SequelizeRepository.getTransaction(req);

    const tenantId = req.params.tenantId;
    const userId = req.params.id;

    // Prevent a user from suspending themself
    if (String(req.currentUser && req.currentUser.id) === String(userId)) {
      throw new Error400(req.language, 'user.errors.suspendingHimself');
    }

    let tenantUser = await TenantUserRepository.findByTenantAndUser(
      tenantId,
      userId,
      req,
    );

    if (!tenantUser) {
      throw new Error('TenantUser not found');
    }

    tenantUser.status = 'archived';
    await tenantUser.save({ transaction });

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: userId,
        action: AuditLogRepository.UPDATE,
        values: {
          id: userId,
          status: 'archived',
        },
      },
      req,
    );

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
