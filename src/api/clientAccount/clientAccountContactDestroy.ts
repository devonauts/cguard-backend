import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientContactService from '../../services/clientContactService';
import assertClientAccess from '../../services/user/assertClientAccess';
import assertClientOwnsSubResource from '../../services/user/assertClientOwnsSubResource';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientContactDestroy,
    );
    await assertClientAccess(req, req.params.id);
    // The contact must belong to the client in the path, not just the tenant.
    await assertClientOwnsSubResource(req, {
      model: req.database.clientContact, subId: req.params.contactId,
      clientAccountId: req.params.id, clientKey: 'clientAccountId',
    });

    const id = req.params.contactId;

    await new ClientContactService(req).destroy(id);
    const messageCode = 'clients.contacts.contactDeleted';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};