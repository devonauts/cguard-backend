import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NoteService from '../../services/noteService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.noteCreate,
    );

    const guardId = req.params.id;
    const data = req.body || {};
    data.notableType = 'securityGuard';
    data.notableId = guardId;

    const created = await new NoteService(req).create(data);
    const messageCode = 'notes.noteCreated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: created });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};