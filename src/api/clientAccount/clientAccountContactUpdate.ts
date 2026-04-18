/** @openapi { "summary": "Update client contact", "description": "Update a contact of a client account.", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "lastName": { "type": "string" }, "email": { "type": "string", "format": "email" }, "phoneNumber": { "type": "string" }, "address": { "type": "string" }, "addressComplement": { "type": "string" }, "zipCode": { "type": "string" }, "city": { "type": "string" }, "country": { "type": "string" }, "faxNumber": { "type": "string" }, "website": { "type": "string" }, "active": { "type": "boolean" }, "position": { "type": "string" } } } } } }, "responses": { "200": { "description": "Contact updated" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientContactService from '../../services/clientContactService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.clientContactEdit,
    );

    const id = req.params.contactId;
    const data = req.body || {};

    const updated = await new ClientContactService(req).update(id, data);
    const messageCode = 'clients.contacts.contactUpdated';
    const lang = req && req.language ? req.language : undefined;
    const message = i18n(lang, messageCode);

    await ApiResponseHandler.success(req, res, { messageCode, message, data: updated });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};