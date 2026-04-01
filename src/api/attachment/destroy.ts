import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import AttachmentService from '../../services/attachmentService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.attachmentDestroy,
    );

    const id = req.params.id;

    await new AttachmentService(req).destroy(id);

    const messageCode = 'attachments.attachmentDeleted';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};