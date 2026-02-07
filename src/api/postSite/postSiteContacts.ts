import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientContactService from '../../services/clientContactService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientContactRead,
    );

    const postSiteId = req.params.id;

    const payload = await new ClientContactService(req).findAndCountAll({
      filter: { postSiteId },
      limit: req.query.limit,
      offset: req.query.offset,
      orderBy: req.query.orderBy,
    });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
