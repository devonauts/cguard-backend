import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import AttachmentService from '../../services/attachmentService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.attachmentRead,
    );

    const { notableType, notableId, limit, offset } = req.query;

    const payload = await new AttachmentService(req).findAndCountAll({
      filter: { notableType, notableId },
      limit: limit,
      offset: offset,
    });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};