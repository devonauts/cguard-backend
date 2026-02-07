import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentService from '../../services/incidentService';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.incidentRead,
    );

    const tenant = SequelizeRepository.getCurrentTenant(req);
    const clientId = req.params.id;

    // Fetch station ids for this client
    const sequelize = req.database && req.database.sequelize ? req.database.sequelize : null;
    if (!sequelize) {
      throw new Error('Database connection unavailable');
    }

    // Try primary query first; fall back to safer queries if column(s) are missing in this DB
    let stations: any[] = [];
    try {
      const [s] = await sequelize.query(
        `SELECT id FROM stations
         WHERE (stationOriginId = :clientId OR clientAccountId = :clientId OR client_account_id = :clientId)
           AND deletedAt IS NULL
           AND (tenantId = :tenantId OR tenantId IS NULL)`,
        { replacements: { clientId, tenantId: tenant.id } },
      );
      stations = s || [];
    } catch (err) {
      try {
        const [s2] = await sequelize.query(
          `SELECT id FROM stations
           WHERE (stationOriginId = :clientId OR client_account_id = :clientId)
             AND deletedAt IS NULL
             AND (tenantId = :tenantId OR tenantId IS NULL)`,
          { replacements: { clientId, tenantId: tenant.id } },
        );
        stations = s2 || [];
      } catch (err2) {
        try {
          const [s3] = await sequelize.query(
            `SELECT id FROM stations
             WHERE stationOriginId = :clientId
               AND deletedAt IS NULL
               AND (tenantId = :tenantId OR tenantId IS NULL)`,
            { replacements: { clientId, tenantId: tenant.id } },
          );
          stations = s3 || [];
        } catch (err3) {
          await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
          return;
        }
      }
    }

    const stationIds = (stations || []).map((s: any) => s.id).filter(Boolean);

    if (!stationIds.length) {
      await ApiResponseHandler.success(req, res, { rows: [], count: 0 });
      return;
    }

    const args: any = {};
    const raw = req.query || {};

    args.filter = raw.filter && typeof raw.filter === 'object' ? raw.filter : {};
    args.filter.stationIncidents = stationIds;

    if (raw.limit) args.limit = raw.limit;
    if (raw.offset) args.offset = raw.offset;
    if (raw.orderBy) args.orderBy = raw.orderBy;

    const payload = await new IncidentService(req).findAndCountAll(args);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};