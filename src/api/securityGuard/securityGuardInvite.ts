import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import UserCreator from '../../services/user/userCreator';
import UserRepository from '../../database/repositories/userRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import Roles from '../../security/roles';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardCreate,
    );

    let incoming = req.body && req.body.data ? req.body.data : req.body;

    // If payload wrapped as { entries: [...] }, take the first entry
    if (incoming && incoming.entries && Array.isArray(incoming.entries)) {
      incoming = incoming.entries[0];
    }

    if (!incoming) {
      return await ApiResponseHandler.error(req, res, new Error('Empty invite payload'));
    }

    // If contact provided but no guard id, create/invite the user
    let invitedUser: any = null;
    if ((!incoming.guard) && incoming.contact) {
      await new UserCreator(req).execute(
        { emails: [incoming.contact], roles: [Roles.values.securityGuard] },
        true,
      );

      invitedUser = await UserRepository.findByEmailWithoutAvatar(incoming.contact, req);
      if (!invitedUser) {
        throw new Error('Unable to create or find user for contact ' + incoming.contact);
      }

      incoming.guard = invitedUser.id;
    }

    // Mark as draft if missing required fields
    const requiredFields = [
      'governmentId',
      'fullName',
      'gender',
      'bloodType',
      'birthDate',
      'maritalStatus',
      'academicInstruction',
    ];

    const missingRequired = requiredFields.some((f) => !incoming[f]);
    if (missingRequired && !incoming.isDraft) {
      incoming.isDraft = true;
    }

    const created = await new SecurityGuardService(req).create(incoming);

    // Get invitation token for the invited user (if any)
    let invitationToken = null;
    try {
      const tenantUser = await TenantUserRepository.findByTenantAndUser(
        req.params.tenantId,
        invitedUser ? invitedUser.id : incoming.guard,
        req,
      );
      if (tenantUser) {
        invitationToken = tenantUser.invitationToken;
      }
    } catch (e) {
      // ignore
    }

    return await ApiResponseHandler.success(req, res, {
      securityGuardId: created.id,
      invitationToken,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
