import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    const tenant = SequelizeRepository.getCurrentTenant(req);
    const clientId = req.params.id;

    const sequelize = req.database && req.database.sequelize ? req.database.sequelize : null;
    if (!sequelize) {
      throw new Error('Database connection unavailable');
    }

    // Try to gather pivot rows which may store either securityGuardId or reference tenantUsers
    const [rows] = await sequelize.query(
      `SELECT tuc.securityGuardId, tu.userId
       FROM tenant_user_client_accounts tuc
       LEFT JOIN tenantUsers tu ON tu.id = tuc.tenantUserId
       WHERE tuc.clientAccountId = :clientId
         AND (tu.tenantId = :tenantId OR tuc.tenantId = :tenantId)
         AND tuc.deletedAt IS NULL
         AND (tu.deletedAt IS NULL OR tu.deletedAt IS NULL)`,
      { replacements: { clientId, tenantId: tenant.id } },
    );

    console.debug('[clientAccountGuards] pivot rows for client', clientId, rows);

    const securityGuardIds = (rows || []).map((r: any) => r.securityGuardId).filter(Boolean);
    const userIds = (rows || []).map((r: any) => r.userId).filter(Boolean);

    if (!securityGuardIds.length && !userIds.length) {
      await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
      return;
    }

    const args: any = {};
    const raw = req.query || {};

    args.filter = raw.filter && typeof raw.filter === 'object' ? raw.filter : {};

    // Prefer filtering by securityGuard.id when present, otherwise by tenantUser.userId (guard user id)
    if (securityGuardIds.length) {
      args.filter.id = securityGuardIds;
    } else {
      args.filter.guard = userIds;
    }

    if (raw.limit) args.limit = raw.limit;
    if (raw.offset) args.offset = raw.offset;
    if (raw.orderBy) args.orderBy = raw.orderBy;

    const payload = await new SecurityGuardService(req).findAndCountAll(args);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};