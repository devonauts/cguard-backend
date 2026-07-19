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

    // Client stations = linked directly (stationOriginId) OR under any of the
    // client's post-sites — the same scope operation/personnel/board use.
    // (The old raw SQL referenced a nonexistent stations.clientAccountId column,
    // ALWAYS errored, and fell back to stationOriginId-only: the Resumen tab
    // missed every incident at site-linked stations — the normal case.)
    const { Op } = req.database.Sequelize;
    // NOTE: no .catch(() => []) here — a DB failure must propagate to the outer
    // handler as an error, not degrade into an empty-but-successful list.
    const sites = await req.database.businessInfo.findAll({
      where: { clientAccountId: clientId, tenantId: tenant.id },
      attributes: ['id'],
    });
    const siteIds = (sites || []).map((s: any) => s.id).filter(Boolean);
    const stationWhere: any[] = [{ stationOriginId: clientId }];
    if (siteIds.length) stationWhere.push({ postSiteId: siteIds });
    const stations = await req.database.station.findAll({
      where: { tenantId: tenant.id, [Op.or]: stationWhere },
      attributes: ['id'],
    });

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