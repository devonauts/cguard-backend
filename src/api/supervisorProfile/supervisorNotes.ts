/**
 * Supervisor notes — reuses the SAME polymorphic `note` model/NoteService the
 * guard notes use, keyed by notableType='supervisorProfile' + notableId=<user id>.
 * No new model/migration (the note model is already polymorphic). Guard-safe:
 * supervisors need no securityGuard row.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import NoteService from '../../services/noteService';
import AttachmentService from '../../services/attachmentService';
import { i18n } from '../../i18n';

const NOTABLE_TYPE = 'supervisorProfile';

/** GET /tenant/:tenantId/supervisors/:userId/notes */
export const listSupervisorNotes = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.noteRead);
    const payload = await new NoteService(req).findAndCountAll({
      filter: { notableType: NOTABLE_TYPE, notableId: req.params.userId },
      limit: req.query.limit,
      offset: req.query.offset,
    });
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/supervisors/:userId/notes */
export const createSupervisorNote = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.noteCreate);
    const data = req.body || {};
    data.notableType = NOTABLE_TYPE;
    data.notableId = req.params.userId;

    const created = await new NoteService(req).create(data);

    // Link any uploaded attachment metadata to the created note (same as guards).
    if (Array.isArray(data.attachment) && data.attachment.length > 0) {
      try {
        for (const a of data.attachment) {
          await new AttachmentService(req).create({
            name: a.name,
            mimeType: a.mimeType || a.type || 'application/octet-stream',
            sizeInBytes: a.sizeInBytes || a.size || 0,
            storageId: a.storageId || null,
            privateUrl: a.privateUrl || a.private_url || null,
            publicUrl: a.publicUrl || a.public_url || null,
            notableType: 'note',
            notableId: created.id,
          });
        }
      } catch (e) {
        console.warn('Failed to create attachments for supervisor note', e instanceof Error ? e.message : String(e));
      }
    }

    const messageCode = 'notes.noteCreated';
    await ApiResponseHandler.success(req, res, { messageCode, message: i18n(req?.language, messageCode), data: created });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
