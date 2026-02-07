import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientContactService from '../../services/clientContactService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientContactRead,
    );

    const args: any = {};
    const raw = req.query || {};
    if (raw.filter && typeof raw.filter === 'object') {
      args.filter = raw.filter;
    } else {
      args.filter = {};
      for (const key of Object.keys(raw)) {
        if (key.startsWith('filter[')) {
          const inner = key.replace(/^filter\[(.*)\]$/, '$1');
          args.filter[inner] = raw[key];
        } else if (key.startsWith('filter.')) {
          const inner = key.replace(/^filter\.(.*)$/, '$1');
          args.filter[inner] = raw[key];
        }
      }
    }

    args.filter.clientAccountId = req.params.id;

    if (raw.limit) args.limit = raw.limit;
    if (raw.offset) args.offset = raw.offset;
    if (raw.orderBy) args.orderBy = raw.orderBy;

    const payload = await new ClientContactService(req).findAndCountAll(args);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};