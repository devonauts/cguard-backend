import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import AttachmentService from '../../services/attachmentService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.attachmentCreate,
    );

    let data = req.body || {};

    // If client provided a fileToken (encrypted privateUrl), decrypt it and
    // populate data.privateUrl so the repository stores the real path.
    if (!data.privateUrl && data.fileToken) {
      try {
        const { decryptPrivateUrl } = require('../../utils/privateUrlEncryption');
        data.privateUrl = decryptPrivateUrl(String(data.fileToken));
      } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('Failed to decrypt fileToken for attachment create', msg);
        throw e;
      }
    }

    // Attach tenant from request
    // notableType and notableId must be provided by caller

    const created = await new AttachmentService(req).create(data);
    const messageCode = 'attachments.attachmentCreated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: created });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
