/** @openapi { "summary": "Update a note for a client account", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "title": { "type": "string" }, "description": { "type": "string" }, "noteDate": { "type": "string", "format": "date-time" }, "attachment": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "mimeType": { "type": "string" }, "sizeInBytes": { "type": "integer" }, "storageId": { "type": "string" }, "privateUrl": { "type": "string" }, "publicUrl": { "type": "string" } } } } }, "required": [] } } } }, "responses": { "200": { "description": "Note updated with payload" }, "400": { "description": "Validation error" } } } */

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
      Permissions.values.noteEdit,
    );
    await assertClientAccess(req, req.params.id);
    // Notes are polymorphic (notableType/notableId). The note must be a note of
    // THIS client (notableId === path client), not merely same-tenant.
    await assertClientOwnsSubResource(req, {
      model: req.database.note, subId: req.params.noteId,
      clientAccountId: req.params.id, clientKey: 'notableId',
    });

    const noteId = req.params.noteId;
    const data = req.body || {};

    const updated = await new NoteService(req).update(noteId, data);
    const messageCode = 'notes.noteUpdated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: updated });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};