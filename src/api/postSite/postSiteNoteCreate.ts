/** @openapi { "summary": "Create a note for a post site", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "title": { "type": "string" }, "description": { "type": "string" }, "noteDate": { "type": "string", "format": "date-time" }, "attachment": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "mimeType": { "type": "string" }, "sizeInBytes": { "type": "integer" }, "storageId": { "type": "string" }, "privateUrl": { "type": "string" }, "publicUrl": { "type": "string" } } } } }, "required": ["title"] } } } }, "responses": { "200": { "description": "Note created with payload" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NoteService from '../../services/noteService';
import AttachmentService from '../../services/attachmentService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.noteCreate,
    );

    const postSiteId = req.params.id;
    const data = req.body || {};
    data.notableType = 'postSite';
    data.notableId = postSiteId;

    const created = await new NoteService(req).create(data);

    if (Array.isArray(data.attachment) && data.attachment.length > 0) {
      try {
        for (const a of data.attachment) {
          const attachmentPayload = {
            name: a.name,
            mimeType: a.mimeType || a.type || 'application/octet-stream',
            sizeInBytes: a.sizeInBytes || a.size || 0,
            storageId: a.storageId || null,
            privateUrl: a.privateUrl || a.private_url || a.privateUrl,
            publicUrl: a.publicUrl || a.public_url || a.publicUrl || null,
            notableType: 'note',
            notableId: created.id,
          };
          await new AttachmentService(req).create(attachmentPayload);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Failed to create attachments for note', msg);
      }
    }
    const messageCode = 'notes.noteCreated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: created });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};