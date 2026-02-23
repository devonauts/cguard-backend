/**
 * @openapi {
 *  "summary": "Create a user",
 *  "description": "Creates a new user in the tenant.",
 *  "requestBody": {
 *    "content": {
 *      "application/json": {
 *        "schema": {
 *          "type": "object",
 *          "properties": {
 *            "emails": { "type": "array", "items": { "type": "string" } },
 *            "fullName": { "type": "string" },
 *            "roles": { "type": "array", "items": { "type": "string" } }
 *          }
 *        }
 *      }
 *    }
 *  },
 *  "responses": { "200": { "description": "OK" } }
 * }
 */
import UserCreator from '../../services/user/userCreator';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountRepository from '../../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../../database/repositories/businessInfoRepository';
import Error400 from '../../errors/Error400';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userCreate,
    );

    let creator = new UserCreator(req);

    try {
      const incoming = req.body.data || req.body || {};

      // Normalize single `role` to `roles` array expected by UserCreator
      if (incoming.role && !incoming.roles) {
        incoming.roles = [incoming.role];
      }

      // Normalize single `email` to `emails` if needed (UserCreator accepts email or emails)
      if (incoming.email && !incoming.emails) {
        if (Array.isArray(incoming.email)) {
          incoming.emails = incoming.email;
        } else {
          incoming.emails = [incoming.email];
        }
      }

      // Map `name` (frontend) to `fullName` expected by UserCreator
      if (incoming.name && !incoming.fullName && !incoming.firstName && !incoming.lastName) {
        incoming.fullName = incoming.name;
      }

      // Validate that the email(s) are not already used by another user
      if (incoming.emails && incoming.emails.length) {
        const UserRepository = require('../../database/repositories/userRepository').default;
        for (const e of incoming.emails) {
          if (!e || typeof e !== 'string') continue;
          const existing = await UserRepository.findByEmailWithoutAvatar(e, req);
          if (existing) {
            // If a user with this email already exists, prevent creating a new one via this endpoint
            const Error400 = require('../../errors/Error400').default;
            throw new Error400(req.language, 'auth.emailAlreadyInUse');
          }
        }
      }

      // Validate provided clientIds/postSiteIds belong to the tenant BEFORE creating
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

      await creator.execute(incoming);
    } catch (err) {
      console.error('Error en UserCreator.execute:', err);
      throw err;
    }

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
