import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import VisitorLogService from '../../services/visitorLogService';
import AttachmentService from '../../services/attachmentService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.visitorLogCreate,
    );

    const payload = await new VisitorLogService(req).create(req.body.data);

    // If frontend sent attachment metadata, create attachment records and link to the created visitor log
    if (Array.isArray(req.body?.data?.attachment) && req.body.data.attachment.length > 0) {
      try {
        for (const a of req.body.data.attachment) {
          const att = { ...a };
          if (!att.privateUrl && att.fileToken) {
            try {
              const { decryptPrivateUrl } = require('../../utils/privateUrlEncryption');
              att.privateUrl = decryptPrivateUrl(String(att.fileToken));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn('Failed to decrypt fileToken for visitor attachment', msg);
            }
          }

          const attachmentPayload = {
            name: att.name,
            mimeType: att.mimeType || att.type || 'application/octet-stream',
            sizeInBytes: att.sizeInBytes || att.size || 0,
            storageId: att.storageId || null,
            privateUrl: att.privateUrl || att.private_url || null,
            publicUrl: att.publicUrl || att.public_url || null,
            notableType: 'visitorLog',
            notableId: payload.id,
          };

          try {
            await new AttachmentService(req).create(attachmentPayload);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('Failed to create attachment for visitor log', msg);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Unhandled error while creating visitor attachments', msg);
      }
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
