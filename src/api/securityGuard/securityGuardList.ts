import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardRead,
    );

    // Normalize query args: build { filter, limit, offset, orderBy }
    const raw = req.query || {};

    let args: any = {};

    // If frontend already sent a nested filter object, use it
    if (raw.filter && typeof raw.filter === 'object') {
      args.filter = raw.filter;
    } else {
      args.filter = {};
      // Support keys like filter[archived]=true or filter.status=active
      for (const key of Object.keys(raw)) {
        if (key.startsWith('filter[')) {
          // e.g. filter[archived]
          const inner = key.replace(/^filter\[(.*)\]$/, '$1');
          args.filter[inner] = raw[key];
        } else if (key.startsWith('filter.')) {
          const inner = key.replace(/^filter\.(.*)$/, '$1');
          args.filter[inner] = raw[key];
        }
      }
    }

    // Also copy pagination/order params if present
    if (raw.limit) args.limit = raw.limit;
    if (raw.offset) args.offset = raw.offset;
    if (raw.orderBy) args.orderBy = raw.orderBy;

    const payload = await new SecurityGuardService(
      req,
    ).findAndCountAll(args);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
