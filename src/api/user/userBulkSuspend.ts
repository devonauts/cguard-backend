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
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];

    if (!ids.length) {
      throw new Error400(req.language, 'user.errors.noIdsProvided');
    }

    // Prevent a user from suspending themself
    if (ids.map(String).includes(String(req.currentUser && req.currentUser.id))) {
      throw new Error400(req.language, 'user.errors.suspendingHimself');
    }

    for (const userId of ids) {
      const tenantUser = await TenantUserRepository.findByTenantAndUser(
        tenantId,
        userId,
        req,
      );

      if (!tenantUser) {
        // skip missing
        continue;
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
    }

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
