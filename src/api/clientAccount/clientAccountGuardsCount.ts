import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
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

    // Try counting distinct COALESCE of securityGuardId and userId (works in both Postgres and MySQL)
    let count = 0;

    try {
      const [rows] = await sequelize.query(
        `SELECT COUNT(DISTINCT COALESCE(tuc.securityGuardId, tu.userId)) AS count
         FROM tenant_user_client_accounts tuc
         LEFT JOIN tenantUsers tu ON tu.id = tuc.tenantUserId
         WHERE tuc.clientAccountId = :clientId
           AND (tu.tenantId = :tenantId OR tuc.tenantId = :tenantId)
           AND tuc.deletedAt IS NULL
           AND (tu.deletedAt IS NULL OR tu.deletedAt IS NULL)`,
        { replacements: { clientId, tenantId: tenant.id } },
      );
      count = Number((rows && rows[0] && rows[0].count) || 0);
    } catch (err) {
      // Fallbacks: older DBs might not have securityGuardId column or COALESCE may behave differently
      console.warn('[clientAccountGuardsCount] primary query failed, falling back to tenantUserId or userId count', err instanceof Error ? err.message : String(err));
      try {
        // First try count distinct userId via joined tenantUsers
        const [rows2] = await sequelize.query(
          `SELECT COUNT(DISTINCT tu.userId) AS count
           FROM tenant_user_client_accounts tuc
           JOIN tenantUsers tu ON tu.id = tuc.tenantUserId
           WHERE tuc.clientAccountId = :clientId
             AND tu.tenantId = :tenantId
             AND tuc.deletedAt IS NULL
             AND tu.deletedAt IS NULL`,
          { replacements: { clientId, tenantId: tenant.id } },
        );
        count = Number((rows2 && rows2[0] && rows2[0].count) || 0);
      } catch (err2) {
        // Final fallback: count distinct tenantUserId from pivot
        const [rows3] = await sequelize.query(
          `SELECT COUNT(DISTINCT tuc.tenantUserId) AS count
           FROM tenant_user_client_accounts tuc
           WHERE tuc.clientAccountId = :clientId
             AND tuc.deletedAt IS NULL`,
          { replacements: { clientId } },
        );
        count = Number((rows3 && rows3[0] && rows3[0].count) || 0);
      }
    }

    await ApiResponseHandler.success(req, res, { count });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};