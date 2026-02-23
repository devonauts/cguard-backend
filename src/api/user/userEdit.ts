/**
 * @openapi {
 *  "summary": "Edit a user",
 *  "description": "Updates an existing user by id or payload.",
 *  "requestBody": {
 *    "content": {
 *      "application/json": {
 *        "schema": { "type": "object" }
 *      }
 *    }
 *  },
 *  "responses": { "200": { "description": "OK" } }
 * }
 */
import UserEditor from '../../services/user/userEditor';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountRepository from '../../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../../database/repositories/businessInfoRepository';
import Error400 from '../../errors/Error400';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userEdit,
    );

    let editor = new UserEditor(req);
    const incoming = req.body.data || req.body || {};

    // If frontend sent the id as a route param instead of in the body,
    // populate it so `UserEditor` validation passes.
    if (!incoming.id && req.params && req.params.id) {
      incoming.id = req.params.id;
    }

    // Normalize single `role` to `roles` array expected by UserEditor
    if (incoming.role && !incoming.roles) {
      incoming.roles = [incoming.role];
    }

    // Map `name` (frontend) to `fullName` expected by repositories
    if (incoming.name && !incoming.fullName && !incoming.firstName && !incoming.lastName) {
      incoming.fullName = incoming.name;
    }

    // Validate clientIds/postSiteIds before updating
    if (incoming.clientIds && incoming.clientIds.length) {
      const valid = await ClientAccountRepository.filterIdsInTenant(incoming.clientIds, req);
      if (!valid || valid.length !== incoming.clientIds.length) {
        throw new Error400(req.language, 'user.errors.invalidClientIds');
      }
    }
    if (incoming.postSiteIds && incoming.postSiteIds.length) {
      const valid = await BusinessInfoRepository.filterIdsInTenant(incoming.postSiteIds, req);
      if (!valid || valid.length !== incoming.postSiteIds.length) {
        throw new Error400(req.language, 'user.errors.invalidPostSiteIds');
      }
    }

    await editor.update(incoming);

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
