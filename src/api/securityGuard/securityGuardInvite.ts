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

    // If contact provided but no guard id, create/invite the user.
    // Support both email invites and phone (SMS) invites.
    let invitedUser: any = null;
    if ((!incoming.guard) && incoming.contact) {
      const contact = String(incoming.contact).trim();

      // Simple detection: if contains '@' treat as email, otherwise phone
      const isEmail = contact.includes('@');

      if (isEmail) {
        await new UserCreator(req).execute(
          { emails: [contact], roles: [Roles.values.securityGuard] },
          true,
        );

        invitedUser = await UserRepository.findByEmailWithoutAvatar(contact, req);
        if (!invitedUser) {
          throw new Error('Unable to create or find user for contact ' + contact);
        }
      } else {
        // Phone invite: try to find existing user by phone, otherwise create one
        invitedUser = await UserRepository.findByPhone(contact, req);

        if (!invitedUser) {
          const digits = contact.replace(/\D/g, '');
          const syntheticEmail = `${digits || Date.now()}@phone.local`;
          // create minimal user record with phoneNumber and synthetic email
          invitedUser = await UserRepository.create(
            {
              phoneNumber: contact,
              email: syntheticEmail,
              provider: 'phone',
              firstName: incoming.firstName || null,
              lastName: incoming.lastName || null,
              fullName: incoming.fullName || null,
            },
            req,
          );
        }

        // Ensure tenant user entry is created with invitation token
        try {
          await TenantUserRepository.updateRoles(
            req.params.tenantId,
            invitedUser.id,
            [Roles.values.securityGuard],
            req,
          );
        } catch (e) {
          // ignore - updateRoles will throw only in unexpected cases
        }
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
