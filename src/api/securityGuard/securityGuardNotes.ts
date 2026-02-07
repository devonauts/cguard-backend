import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NoteService from '../../services/noteService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.noteRead,
    );

    const guardId = req.params.id;

    const payload = await new NoteService(req).findAndCountAll({
      filter: { notableType: 'securityGuard', notableId: guardId },
      limit: req.query.limit,
      offset: req.query.offset,
    });

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};