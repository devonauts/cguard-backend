import PermissionChecker from '../../services/user/permissionChecker';
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

    const tenantUser = await TenantUserRepository.findByTenantAndUser(
      tenantId,
      userId,
      req,
    );

    if (!tenantUser) {
      throw new Error('TenantUser not found');
    }

    if (tenantUser.status !== 'archived') {
      throw new Error('Only archived users can be restored');
    }

    // Decide restoration status based on whether the user's email is verified.
    let emailVerified = null;
    try {
      const u = await req.database.user.findByPk(userId, { transaction });
      emailVerified = u ? u.emailVerified : null;
    } catch (e) {
      // ignore
    }

    if (emailVerified) {
      tenantUser.status = 'active';
      tenantUser.invitationToken = null;
      tenantUser.invitationTokenExpiresAt = null;
    } else {
      tenantUser.status = 'invited';
      if (!tenantUser.invitationToken) {
        tenantUser.invitationToken = require('crypto').randomBytes(20).toString('hex');
      }
      tenantUser.invitationTokenExpiresAt = new Date(Date.now() + (60 * 60 * 1000));
    }

    await tenantUser.save({ transaction });

    await AuditLogRepository.log(
      {
        entityName: 'user',
        entityId: userId,
        action: AuditLogRepository.UPDATE,
        values: {
          id: userId,
          status: 'active',
        },
      },
      req,
    );

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
