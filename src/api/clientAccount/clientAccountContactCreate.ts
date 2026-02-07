import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientContactService from '../../services/clientContactService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientContactCreate,
    );

    const clientAccountId = req.params.id;
    const data = req.body || {};
    data.clientAccountId = clientAccountId;

    const created = await new ClientContactService(req).create(data);
    const messageCode = 'clients.contacts.contactCreated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: created });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};