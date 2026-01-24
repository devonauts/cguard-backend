import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import RequestService from '../../services/requestService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.requestRead,
    );

    // Normalize query parameters: support both top-level params (status, query)
    // and bracketed filter params like `filter[clientId]=...` which clients send.
    const raw = req.query || {};
    const args: any = { ...raw };
    args.filter = args.filter || {};

    for (const key of Object.keys(raw)) {
      const m = key.match(/^filter\[(.+)\]$/);
      if (m) {
        args.filter[m[1]] = raw[key];
        delete args[key];
      }
    }

    const payload = await new RequestService(
      req,
    ).findAndCountAll(args);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
