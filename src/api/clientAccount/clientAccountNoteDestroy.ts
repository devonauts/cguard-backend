import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NoteService from '../../services/noteService';
import assertClientAccess from '../../services/user/assertClientAccess';
import assertClientOwnsSubResource from '../../services/user/assertClientOwnsSubResource';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.noteDestroy,
    );
    await assertClientAccess(req, req.params.id);
    // The note must belong to THIS client (notableId === path client).
    await assertClientOwnsSubResource(req, {
      model: req.database.note, subId: req.params.noteId,
      clientAccountId: req.params.id, clientKey: 'notableId',
    });

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