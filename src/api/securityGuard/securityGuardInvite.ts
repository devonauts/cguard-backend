import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import UserCreator from '../../services/user/userCreator';
import UserRepository from '../../database/repositories/userRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import Roles from '../../security/roles';
import EmailSender from '../../services/emailSender';
import TenantRepository from '../../database/repositories/tenantRepository';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import crypto from 'crypto';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';

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

    // Detect simple resend requests: payloads that only include guard/contact and optional names
    const minimalResendKeys = ['guard', 'contact', 'firstName', 'lastName', 'isDraft'];
    const incomingKeys = Object.keys(incoming || {});
    const otherKeys = incomingKeys.filter((k) => !minimalResendKeys.includes(k));
    const isResendOnly = (incoming && (incoming.guard || incoming.contact) && otherKeys.length === 0);

    if (isResendOnly) {
      try {
        const tenant = await TenantRepository.findById(req.params.tenantId, req);

        // Resolve recipient email and user id
        let recipientEmail: string | null = null;
        let invitedUserId = incoming.guard || null;
        if (incoming.contact && String(incoming.contact).includes('@')) {
          const contactEmail = String(incoming.contact).trim();
          const byEmail = await UserRepository.findByEmailWithoutAvatar(contactEmail, req);
          if (byEmail) {
            invitedUserId = byEmail.id;
            recipientEmail = contactEmail;
          } else {
            // Create minimal user (without sending invite) so we can generate tenantUser
              try {
              // Create the user but DO NOT send invitation/verification emails here;
              // this endpoint will send a single, enriched invitation email including securityGuardId.
              try {
                await new UserCreator(req).execute(
                  { emails: [contactEmail], roles: [Roles.values.securityGuard], firstName: incoming.firstName || undefined, lastName: incoming.lastName || undefined },
                  false,
                );
              } catch (e) {
                console.error('[securityGuardInvite] UserCreator failed (resend path)', e && (e as any).message ? (e as any).message : e);
                if (e && (e as any).stack) console.error((e as any).stack);
                throw e;
              }
              const created = await UserRepository.findByEmailWithoutAvatar(contactEmail, req);
              if (created) {
                invitedUserId = created.id;
                recipientEmail = contactEmail;
              }
            } catch (e) {
              console.warn('securityGuardInvite.resend: failed to create invited user for email', contactEmail, e && (e as any).message ? (e as any).message : e);
            }
          }
        }

        if (!recipientEmail && invitedUserId) {
          try {
            const u = await UserRepository.findById(invitedUserId, { ...req, bypassPermissionValidation: true });
            if (u && u.email) recipientEmail = u.email;
          } catch (e) {
            console.warn('securityGuardInvite.resend: unable to read user by id for recipient email lookup', invitedUserId, e && (e as any).message ? (e as any).message : e);
          }
        }

        // Ensure tenantUser exists and has an invitationToken
        let tenantUser = null;
        try {
          tenantUser = await TenantUserRepository.findByTenantAndUser(req.params.tenantId, invitedUserId, req);
        } catch (e) {
          // ignore
        }

        if (!tenantUser && invitedUserId) {
          const updated = await TenantUserRepository.updateRoles(req.params.tenantId, invitedUserId, [Roles.values.securityGuard], req);
          if (updated) {
            tenantUser = await TenantUserRepository.findByTenantAndUser(req.params.tenantId, invitedUserId, req);
          }
        }

        if (!tenantUser) {
          throw new Error('No tenantUser found to resend invitation');
        }

        if (!(tenantUser as any).invitationToken) {
          (tenantUser as any).invitationToken = crypto.randomBytes(20).toString('hex');
          await TenantUserRepository.saveTenantUser(tenantUser, req);
        }
          // Log tenantUser state for debugging resend issues
          try {
            console.debug('[securityGuardInvite.resend] tenantUser pre-send', {
              tenantUserId: tenantUser && (tenantUser as any).id,
              userId: tenantUser && (tenantUser as any).userId,
              invitationToken: (tenantUser as any).invitationToken,
              status: (tenantUser as any).status,
              roles: (tenantUser as any).roles,
              recipientEmail,
            });
          } catch (dbg) {
            // ignore logging errors
          }

          if (!(tenantUser as any).invitationToken) {
            (tenantUser as any).invitationToken = crypto.randomBytes(20).toString('hex');
            (tenantUser as any).invitationTokenExpiresAt = new Date(Date.now() + (60 * 60 * 1000));
            await TenantUserRepository.saveTenantUser(tenantUser, req);
            console.debug('[securityGuardInvite.resend] generated invitationToken', { tenantUserId: (tenantUser as any).id, invitationToken: (tenantUser as any).invitationToken });
          }

        // Try to find associated securityGuard record to include securityGuardId in link
        let securityGuardId = null;
        try {
          const sg = await SecurityGuardRepository.findAndCountAll({ filter: { guard: invitedUserId }, limit: 1, offset: 0 }, req);
          if (sg && sg.rows && sg.rows.length) {
            securityGuardId = sg.rows[0].id;
          }
        } catch (e) {
          // ignore
        }

        const link = `${tenantSubdomain.frontendUrl(tenant)}/auth/invitation?token=${(tenantUser as any).invitationToken}&securityGuardId=${securityGuardId || ''}`;

        if (recipientEmail) {
          // Do NOT generate an email verification token for invite/resend flows.
          // Invitation should send only the invitation message; verification
          // tokens are unnecessary for invited users and cause duplicate emails.
          let emailVerificationToken: string | null = null;
          let guardObj = null;
          if (invitedUserId) {
            try {
              guardObj = await UserRepository.findById(invitedUserId, { ...req, bypassPermissionValidation: true });
            } catch (e) {
              console.warn('securityGuardInvite.resend: failed to fetch guard user for email payload', invitedUserId, e && (e as any).message ? (e as any).message : e);
            }
          }

          try {
            await new EmailSender(
              EmailSender.TEMPLATES.INVITATION,
              {
                tenant: tenant || null,
                link,
                guard: guardObj,
                invitation: true,
              },
            ).sendTo(recipientEmail);
            console.debug('[securityGuardInvite.resend] templated send succeeded', { recipientEmail });
          } catch (sendErr) {
            console.warn('[securityGuardInvite.resend] templated send failed, trying fallback', sendErr && (sendErr as any).message ? (sendErr as any).message : sendErr);
            try {
              await new EmailSender(
                EmailSender.TEMPLATES.INVITATION,
                {
                  tenant: tenant || null,
                  link,
                  guard: guardObj,
                  invitation: true,
                },
              ).sendTo(recipientEmail);
              console.debug('[securityGuardInvite.resend] fallback send succeeded', { recipientEmail });
            } catch (fallbackErr) {
              console.warn('[securityGuardInvite.resend] fallback send also failed', fallbackErr && (fallbackErr as any).message ? (fallbackErr as any).message : fallbackErr);
            }
          }

          return await ApiResponseHandler.success(req, res, { resent: true });
        }

        throw new Error('No recipient email available for resend');
      } catch (e) {
        console.error('Failed to resend invitation (securityGuard):', e && (e as any).message ? (e as any).message : e);
        if (e && (e as any).stack) console.error((e as any).stack);
        return await ApiResponseHandler.error(req, res, e);
      }
    }

    // If contact provided but no guard id, create/invite the user.
    // Support both email invites and phone (SMS) invites.
    let invitedUser: any = null;
    if ((!incoming.guard) && incoming.contact) {
      const contact = String(incoming.contact).trim();

      // Simple detection: if contains '@' treat as email, otherwise phone
      const isEmail = contact.includes('@');

      if (isEmail) {
        // Defensive: if there is already a tenant_user in this tenant with
        // the same email, reuse that user instead of creating a duplicate.
        try {
          const existingTenantUser = await TenantUserRepository.findByTenantAndEmail(req.params.tenantId, contact, req);
          if (existingTenantUser && existingTenantUser.user) {
            invitedUser = existingTenantUser.user;
          }
        } catch (e) {
          console.warn('securityGuardInvite: findByTenantAndEmail failed', e && (e as any).message ? (e as any).message : e);
        }

        if (!invitedUser) {
          // Create the user but do NOT let UserCreator automatically send
          // invitation emails — this endpoint will send a single, enriched
          // invitation email including the securityGuardId.
          // Create the user but DO NOT let UserCreator send invitation emails;
          // this endpoint will compose and send a single invitation that includes the securityGuardId.
          try {
            await new UserCreator(req).execute(
              { emails: [contact], roles: [Roles.values.securityGuard], firstName: incoming.firstName || undefined, lastName: incoming.lastName || undefined },
              false,
            );
          } catch (e) {
            console.error('[securityGuardInvite] UserCreator failed (create path)', e && (e as any).message ? (e as any).message : e);
            if (e && (e as any).stack) console.error((e as any).stack);
            throw e;
          }

          invitedUser = await UserRepository.findByEmailWithoutAvatar(contact, req);
          if (!invitedUser) {
            throw new Error('Unable to create or find user for contact ' + contact);
          }
        }
        // Ensure there's a tenantUser record for this invited user so that
        // downstream calls that call UserRepository.filterIdInTenant
        // will succeed and the securityGuard record can be created.
        try {
          await TenantUserRepository.updateRoles(
            req.params.tenantId,
            invitedUser.id,
            [Roles.values.securityGuard],
            req,
          );
        } catch (e) {
          console.warn('Failed to ensure tenantUser for invited email user:', invitedUser && invitedUser.id, e && (e as any).message ? (e as any).message : e);
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

    // After creating the securityGuard, send invitation email including securityGuardId
    try {
      const tenant = await TenantRepository.findById(req.params.tenantId, req);

      // Fetch user to include merged info
      const guardUser = await UserRepository.findById(incoming.guard, req);

      // Do NOT generate an email verification token for invite creation flows.
      // Invitation should only send the invitation template; avoid sending
      // an extra verification email or persisting unnecessary tokens.
      let emailVerificationToken: string | null = null;

      const link = `${tenantSubdomain.frontendUrl(tenant)}/auth/invitation?token=${invitationToken || ''}&securityGuardId=${created.id}`;
      if (guardUser && guardUser.email && guardUser.provider !== 'phone' && !String(guardUser.email).endsWith('@phone.local')) {
        const recipientEmail = guardUser.email || incoming.contact;
        if (recipientEmail) {
          await new EmailSender(
            EmailSender.TEMPLATES.INVITATION,
            {
              tenant: tenant || null,
              link,
              guard: {
                id: guardUser.id,
                firstName: guardUser.firstName || null,
                lastName: guardUser.lastName || null,
                email: guardUser.email,
              },
              invitation: true,
            },
          ).sendTo(recipientEmail);
        }
      } else {
          // No email available (phone invite). Frontend should send SMS using the invitation token.
          console.log('📨 Phone invite created; will rely on tenant invitation token for SMS flow');
        }
    } catch (e) {
      console.warn('Failed to send invitation email with securityGuardId:', e && (e as any).message ? (e as any).message : e);
    }

    return await ApiResponseHandler.success(req, res, {
      securityGuardId: created.id,
      invitationToken,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
