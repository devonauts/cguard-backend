/** @openapi { "summary": "Edit a user", "description": "Updates an existing user by id or payload.", "requestBody": { "content": { "application/json": { "schema": { "type": "object" } } } }, "responses": { "200": { "description": "OK" } } } */
import UserEditor from '../../services/user/userEditor';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import ClientAccountRepository from '../../database/repositories/clientAccountRepository';
import BusinessInfoRepository from '../../database/repositories/businessInfoRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import Error400 from '../../errors/Error400';
import { Op } from 'sequelize';

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

    // UserEditor only persists roles/assignments (tenantUser row) — identity
    // fields never landed on the USER row, so renaming an administrative user
    // or changing their email silently reverted (same class as the client
    // rename bug). Persist them here, email only when no other account owns it.
    {
      const targetUserId = req.params?.id || incoming.id;
      const target = targetUserId
        ? await req.database.user.findByPk(targetUserId)
        : null;
      if (target) {
        const patch: any = {};
        const reqFullName = (incoming.fullName || incoming.name || '').toString().trim();
        if (reqFullName && reqFullName !== (target.fullName || '').toString().trim()) {
          patch.fullName = reqFullName;
          const parts = reqFullName.split(/\s+/);
          patch.firstName = parts[0] || null;
          patch.lastName = parts.slice(1).join(' ') || null;
        }
        const reqEmail = incoming.email
          ? incoming.email.toString().trim().toLowerCase()
          : '';
        if (reqEmail && reqEmail !== (target.email || '').toString().trim().toLowerCase()) {
          const taken = await req.database.user.findOne({
            where: { email: reqEmail, id: { [Op.ne]: target.id } },
          });
          if (taken) {
            throw new Error400(
              req.language,
              'errors.validation.message',
              'Ese correo ya pertenece a otra cuenta.',
            );
          }
          patch.email = reqEmail;
        }
        if (typeof incoming.phoneNumber !== 'undefined') {
          const reqPhone = (incoming.phoneNumber || '').toString().trim();
          if (reqPhone !== (target.phoneNumber || '').toString().trim()) {
            patch.phoneNumber = reqPhone || null;
          }
        }
        if (Object.keys(patch).length) {
          patch.updatedById = req.currentUser?.id || null;
          await target.update(patch);
          // Fan out to every denormalized identity copy (guard rows, client
          // accounts of this user, etc.). Best-effort.
          try {
            const { syncIdentityFromUser } = require('../../services/identitySync');
            await syncIdentityFromUser(req.database, target.id, req);
          } catch (e: any) {
            console.warn('userEdit: identity fan-out failed', e?.message || e);
          }
        }
      }
    }

    // Per-user permission overrides are a privileged, admin-level action: they
    // grant/revoke individual permissions on top of roles. Require settingsEdit
    // (admin) in addition to userEdit, and enforce the admin-floor lockout
    // guards in the repository.
    if (incoming.permissionOverrides && (req.params?.id || incoming.id)) {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      await TenantUserRepository.updatePermissionOverrides(
        req.currentTenant && req.currentTenant.id,
        req.params?.id || incoming.id,
        incoming.permissionOverrides,
        req,
      );
    }

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
