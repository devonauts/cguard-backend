import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NoteService from '../../services/noteService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.noteDestroy,
    );

    const noteId = req.params.noteId;

    await new NoteService(req).destroy(noteId);

    const messageCode = 'notes.noteDeleted';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};