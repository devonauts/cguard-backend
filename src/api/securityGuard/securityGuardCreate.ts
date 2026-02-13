import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import Error400 from '../../errors/Error400';
import moment from 'moment';
import UserCreator from '../../services/user/userCreator';
import EmailSender from '../../services/emailSender';
import TenantRepository from '../../database/repositories/tenantRepository';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import UserRepository from '../../database/repositories/userRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import crypto from 'crypto';
import Roles from '../../security/roles';
import bcrypt from 'bcryptjs';

export default async (req, res, next) => {
  // Preserve the original currentUser (actor) and tenant before any possible impersonation
  let originalCurrentUser = req.currentUser;
  let originalCurrentTenant = req.currentTenant;
  try {
    // Allow invited user flow: if frontend provides an invitation token in the body
    // impersonate the invited tenantUser for this request and bypass the HR permission.
    // This enables the invited guard to complete registration from the frontend.
    let bypassPermission = false;
    const _incomingRaw = req.body && req.body.data ? req.body.data : req.body;
    const providedToken = (_incomingRaw && (_incomingRaw.token || _incomingRaw.invitationToken)) || (req.body && (req.body.token || req.body.invitationToken));
    let impersonatedTenantUser: any = null;
    if (providedToken && !req.currentUser) {
      try {
        const tenantUser = await TenantUserRepository.findByInvitationToken(
          providedToken,
          req,
        );
        if (tenantUser) {
          req.currentUser = tenantUser.user;
          req.currentTenant = tenantUser.tenant;
          impersonatedTenantUser = tenantUser;
          // Allow repository calls during the invite impersonation to update
          // tenant_user roles even when the target user id equals the current
          // impersonated user id. This avoids the "prevented self role update"
          // protective check that otherwise blocks tenantUser creation/update
          // in invite flows.
          try {
            req.allowSelfRoleUpdate = true;
          } catch (e) {
            // ignore if request object is frozen
          }
          bypassPermission = true;
          console.log('🔐 [securityGuardCreate] invited flow: impersonated user id', req.currentUser && req.currentUser.id);
        }
      } catch (e) {
        // ignore lookup errors and fall through to normal permission check
      }
    }

    if (!bypassPermission) {
      new PermissionChecker(req).validateHas(
        Permissions.values.securityGuardCreate,
      );
    }

    // Accept both { data: { ... } } and direct body formats from frontend
    let incoming = req.body && req.body.data ? req.body.data : req.body;

    // Support `email` field from frontend as an alias for `contact`
    if (incoming && !incoming.contact && incoming.email) {
      incoming.contact = incoming.email;
    }

    // If frontend sent { entries: [...] } handle that shape
    if (incoming && incoming.entries && Array.isArray(incoming.entries)) {
      incoming = incoming.entries;
    }

    // If we now have an array of entries, normalize common aliases into `contact`
    // so downstream logic that expects `contact` (email or phone) works consistently.
    if (Array.isArray(incoming)) {
      incoming = incoming.map((item) => {
        if (item && !item.contact) {
          if (item.email) item.contact = item.email;
          else if (item.emailAddress) item.contact = item.emailAddress;
          else if (item.phoneNumber) item.contact = item.phoneNumber;
          else if (item.phone) item.contact = item.phone;
        }
        return item;
      });
    }

    // If frontend sent an array of invites, handle multiple entries
    const isArray = Array.isArray(incoming);
    if (isArray && incoming.length === 0) {
      return await ApiResponseHandler.error(req, res, new Error('Empty invite payload'));
    }

    // Log incoming payload for debugging
    console.log('🔔 [securityGuardCreate] incoming payload keys:', Object.keys(incoming || {}));
    console.log('🔔 [securityGuardCreate] incoming payload preview:', JSON.stringify(incoming || {}, (k, v) => (k === 'profileImage' || k === 'credentialImage' || k === 'recordPolicial') ? '[FILE]' : v, 2));

    // Helper to normalize a single entry
    const normalizeEntry = async (entry) => {
      // If we already impersonated a tenantUser via invitation token,
      // prefer using that user's id as the guard instead of creating a new user.
      if ((!entry || !entry.guard) && impersonatedTenantUser) {
        entry = entry || {};
        entry.guard = impersonatedTenantUser.user.id;
        entry._invitationToken = entry._invitationToken || impersonatedTenantUser.invitationToken || null;
      }

      // Normalize guard: allow object with id or direct id
      if (entry && entry.guard && typeof entry.guard === 'object') {
        entry.guard = entry.guard.id || entry.guard;
      }

      // If guard id not provided but contact is provided, create/invite the user
      if ((!entry || !entry.guard) && entry && entry.contact) {
        const contact = String(entry.contact).trim();
        const isEmail = contact.includes('@');

        if (isEmail) {
          // Create or invite the user with role securityGuard via email
          try {
            await new UserCreator({
              currentUser: originalCurrentUser || req.currentUser,
              currentTenant: req.currentTenant,
              language: req.language,
              database: req.database,
            }).execute(
              {
                emails: [contact],
                roles: [Roles.values.securityGuard],
                firstName: entry.firstName || null,
                lastName: entry.lastName || null,
                fullName: entry.fullName || null,
              },
              false,
            );
          } catch (ucErr) {
            console.error('[securityGuardCreate] UserCreator failed (normalizeEntry path)', ucErr && (ucErr as any).message ? (ucErr as any).message : ucErr);
            if (ucErr && (ucErr as any).stack) console.error((ucErr as any).stack);
            throw ucErr;
          }

          // Fetch the user to get its id
          const user = await UserRepository.findByEmailWithoutAvatar(contact, req);
          if (!user) {
            throw new Error('Unable to create or find user for contact ' + contact);
          }

          entry.guard = user.id;

          // Try to find tenantUser to retrieve invitationToken
          try {
            const tenantUser = await TenantUserRepository.findByTenantAndUser(
              req.params.tenantId,
              user.id,
              req,
            );
            if (tenantUser && tenantUser.invitationToken) {
              entry._invitationToken = tenantUser.invitationToken;
            }
          } catch (e) {
            // ignore
          }
        } else {
          // Phone invite: find or create user by phone
          let user = await UserRepository.findByPhone(contact, req);
          if (!user) {
            const digits = contact.replace(/\D/g, '');
            const syntheticEmail = `${digits || Date.now()}@phone.local`;
            user = await UserRepository.create(
              {
                phoneNumber: contact,
                email: syntheticEmail,
                provider: 'phone',
                firstName: entry.firstName || null,
                lastName: entry.lastName || null,
                fullName: entry.fullName || null,
              },
              req,
            );
          }

          // Ensure tenant user entry is created with invitation token
          try {
            const tenantUser = await TenantUserRepository.updateRoles(
              req.params.tenantId,
              user.id,
              [Roles.values.securityGuard],
              req,
            );
            if (tenantUser && tenantUser.invitationToken) {
              entry._invitationToken = tenantUser.invitationToken;
            }
          } catch (e) {
            // ignore
          }

          entry.guard = user.id;
        }
      }

      // guard id is required (FK cannot be null) — surface clear error
      if (!entry || !entry.guard) {
        throw new Error('Guard id is required to create a security guard');
      }

      // Validate governmentId length (frontend sends up to 30 chars)
      if (entry.governmentId && entry.governmentId.length > 50) {
        throw new Error400(req.language, 'entities.securityGuard.errors.validation.governmentIdTooLong');
      }

      // Validate guardCredentials length (DB is VARCHAR(255))
      if (entry.guardCredentials && entry.guardCredentials.length > 255) {
        throw new Error400(req.language, 'entities.securityGuard.errors.validation.guardCredentialsTooLong');
      }

      // Validate minimum age: guard must be at least 18 years old
      if (entry.birthDate) {
        const bd = moment(entry.birthDate);
        if (!bd.isValid() || moment().diff(bd, 'years') < 18) {
          throw new Error400(req.language, 'entities.securityGuard.errors.validation.mustBeAdult');
        }
      }

      // If some DB-required fields are missing, mark as draft so repository will fill placeholders
      const requiredFieldsLocal = [
        'governmentId',
        'fullName',
        'gender',
        'bloodType',
        'birthDate',
        'maritalStatus',
        'academicInstruction',
      ];

      const missingRequiredLocal = requiredFieldsLocal.some((f) => !entry[f]);
      if (missingRequiredLocal && !entry.isDraft) {
        entry.isDraft = true;
      }

      // Normalize client/postSite identifiers to arrays expected by services
      try {
        // clientIds: prefer explicit array, otherwise normalize single or array-shaped clientId
        if (entry.clientIds && !Array.isArray(entry.clientIds)) {
          entry.clientIds = [entry.clientIds];
        }
        if (!entry.clientIds && entry.clientId) {
          entry.clientIds = Array.isArray(entry.clientId)
            ? entry.clientId
            : [entry.clientId];
        }

        // postSiteIds: prefer explicit array, otherwise normalize single or array-shaped postSiteId
        if (entry.postSiteIds && !Array.isArray(entry.postSiteIds)) {
          entry.postSiteIds = [entry.postSiteIds];
        }
        if (!entry.postSiteIds && entry.postSiteId) {
          entry.postSiteIds = Array.isArray(entry.postSiteId)
            ? entry.postSiteId
            : [entry.postSiteId];
        }

        // Ensure single-value fallbacks remain usable by older callers
        if (!entry.clientId && Array.isArray(entry.clientIds) && entry.clientIds.length) {
          entry.clientId = entry.clientIds[0];
        }
        if (!entry.postSiteId && Array.isArray(entry.postSiteIds) && entry.postSiteIds.length) {
          entry.postSiteId = entry.postSiteIds[0];
        }
      } catch (normalizeErr) {
        // don't block creation for normalization issues; log and continue
        console.warn('🔧 [securityGuardCreate] failed to normalize client/postSite ids:', normalizeErr && (normalizeErr as any).message ? (normalizeErr as any).message : normalizeErr);
      }

      return entry;
    };

    // If payload is a single object, handle create/invite and validations at top-level
    if (!isArray) {
      // If guard id not provided but contact is provided, create/invite the user
      if ((!incoming || !incoming.guard) && incoming && incoming.contact) {
        // If impersonation occurred earlier, set incoming.guard from impersonatedTenantUser
        if (impersonatedTenantUser && !incoming.guard) {
          incoming.guard = impersonatedTenantUser.user.id;
          incoming._invitationToken = incoming._invitationToken || impersonatedTenantUser.invitationToken || null;
        }

        // If we assigned guard due to impersonation, skip creating/inviting users.
        if (impersonatedTenantUser && incoming.guard) {
          // Update impersonated user with provided incoming fields (email, names, phone)
          try {
            const userId = impersonatedTenantUser.user.id;
            const dbUser = await req.database.user.findByPk(userId);
            if (dbUser) {
              const updateData: any = {};
              if (incoming.email && (!dbUser.email || dbUser.email !== incoming.email)) {
                updateData.email = incoming.email;
                updateData.emailVerified = false;
              }
              if (incoming.firstName) updateData.firstName = incoming.firstName;
              if (incoming.lastName) updateData.lastName = incoming.lastName;
              if (incoming.phoneNumber) updateData.phoneNumber = incoming.phoneNumber || incoming.phone || null;

              if (Object.keys(updateData).length) {
                // Use the actor (if any) as updater; if none, leave updatedById null
                updateData.updatedById = (req.currentUser && req.currentUser.id) || null;
                await dbUser.update(updateData);
                console.log('🔧 [securityGuardCreate] updated impersonated user with incoming data', { userId, updateDataKeys: Object.keys(updateData) });
                // If frontend provided a password in the invitation completion, persist it now
                if (incoming.password) {
                  try {
                    const BCRYPT_SALT_ROUNDS = 12;
                    const hashed = await bcrypt.hash(incoming.password, BCRYPT_SALT_ROUNDS);
                              console.log('🔍 [securityGuardCreate] setting password for impersonated user id', userId, 'rawLength', String(incoming.password).length);
                              await UserRepository.updatePassword(userId, hashed, false, req);
                              try {
                                const stored = await UserRepository.findPassword(userId, req);
                                console.log('🔎 [securityGuardCreate] stored password present for user id', userId, !!stored);
                              } catch (readErr) {
                                console.warn('⚠️ [securityGuardCreate] failed to read stored password for user id', userId, readErr && (readErr as any).message ? (readErr as any).message : readErr);
                              }
                              console.log('🔧 [securityGuardCreate] set password for impersonated user id', userId);
                    // If this request originated from an invitation token, accept the invitation
                    // so the TenantUser.status moves from 'invited'/'pending' to 'active'.
                    try {
                      if (impersonatedTenantUser && impersonatedTenantUser.invitationToken) {
                        await TenantUserRepository.acceptInvitation(
                          impersonatedTenantUser.invitationToken,
                          req,
                        );
                        console.log('✅ [securityGuardCreate] accepted invitation and activated tenantUser for user id', userId);
                                // Mark email as verified since user completed invite by setting password
                                try {
                                  await UserRepository.markEmailVerified(userId, req);
                                  console.log('✅ [securityGuardCreate] marked email verified for impersonated user id', userId);
                                } catch (markErr) {
                                  console.warn('⚠️ [securityGuardCreate] failed to mark email verified for impersonated user:', userId, markErr && (markErr as any).message ? (markErr as any).message : markErr);
                                }
                      }
                    } catch (acceptErr) {
                      console.warn('🔔 [securityGuardCreate] failed to accept invitation for impersonated user:', acceptErr && (acceptErr as any).message ? (acceptErr as any).message : acceptErr);
                    }
                  } catch (err) {
                    console.warn('🔔 [securityGuardCreate] failed to set password for impersonated user:', err && (err as any).message ? (err as any).message : err);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('🔔 [securityGuardCreate] failed to update impersonated user before create:', e && (e as any).message ? (e as any).message : e);
          }
        } else {
          try {
            const contact = String(incoming.contact).trim();
            const isEmail = contact.includes('@');

            if (isEmail) {
              try {
                await new UserCreator({
                  currentUser: originalCurrentUser || req.currentUser,
                  currentTenant: req.currentTenant,
                  language: req.language,
                  database: req.database,
                }).execute(
                  {
                    emails: [contact],
                    roles: [Roles.values.securityGuard],
                    firstName: incoming.firstName || null,
                    lastName: incoming.lastName || null,
                    fullName: incoming.fullName || null,
                  },
                  false,
                );
              } catch (ucErr) {
                console.error('[securityGuardCreate] UserCreator failed (incoming path)', ucErr && (ucErr as any).message ? (ucErr as any).message : ucErr);
                if (ucErr && (ucErr as any).stack) console.error((ucErr as any).stack);
                return await ApiResponseHandler.error(req, res, ucErr);
              }

              // Fetch the user to get its id
              const user = await UserRepository.findByEmailWithoutAvatar(contact, req);
              if (!user) {
                throw new Error('Unable to create or find user for contact ' + contact);
              }

              incoming.guard = user.id;

              // Try to find tenantUser to retrieve invitationToken
              try {
                const tenantUser = await TenantUserRepository.findByTenantAndUser(
                  req.params.tenantId,
                  user.id,
                  req,
                );
                if (tenantUser && tenantUser.invitationToken) {
                  incoming._invitationToken = tenantUser.invitationToken;
                }
              } catch (e) {
                // ignore — token not critical here
              }
            } else {
              // Phone invite
              let user = await UserRepository.findByPhone(contact, req);
              if (!user) {
                const digits = contact.replace(/\D/g, '');
                const syntheticEmail = `${digits || Date.now()}@phone.local`;
                user = await UserRepository.create(
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

              try {
                // Ensure there's a tenantUser record. If it doesn't exist, updateRoles will create
                // it as invited and generate an invitationToken. If it already exists and is not
                // active but lacks a token, create one without downgrading active users.
                let tenantUser = await TenantUserRepository.findByTenantAndUser(
                  req.params.tenantId,
                  user.id,
                  req,
                );

                if (!tenantUser) {
                  tenantUser = await TenantUserRepository.updateRoles(
                    req.params.tenantId,
                    user.id,
                    [Roles.values.securityGuard],
                    req,
                  );
                } else {
                  // If tenantUser exists but is not active and has no token, generate one
                  if (tenantUser.status !== 'active' && !tenantUser.invitationToken) {
                    // Use the repository to set invited status and token consistently
                    tenantUser.invitationToken = require('crypto')
                      .randomBytes(20)
                      .toString('hex');
                    tenantUser.invitationTokenExpiresAt = new Date(Date.now() + (60 * 60 * 1000));
                    tenantUser.status = 'invited';
                    await tenantUser.save();
                  }
                }

                if (tenantUser && tenantUser.invitationToken) {
                  incoming._invitationToken = tenantUser.invitationToken;
                }
              } catch (e) {
                // ignore
              }

              incoming.guard = user.id;
            }
          } catch (err) {
            return await ApiResponseHandler.error(req, res, err);
          }
        }
      }

      // If we impersonated via invitation token and there's no guard id, set it
      if (!incoming.guard && impersonatedTenantUser) {
        incoming.guard = impersonatedTenantUser.user.id;
        incoming._invitationToken = incoming._invitationToken || impersonatedTenantUser.invitationToken || null;
      }

      // guard id is required (FK cannot be null) — surface clear error
      if (!incoming || !incoming.guard) {
        const err = new Error('Guard id is required to create a security guard');
        return await ApiResponseHandler.error(req, res, err);
      }

      // If some DB-required fields are missing, mark as draft so repository will fill placeholders
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

      if (incoming.isDraft) {
        console.log('📄 Creating security guard as draft for guard:', incoming.guard);
      }
    }

    let payload;
      if (isArray) {
      const results: { record: any; invitationToken: any }[] = [];
      for (const item of incoming) {
        console.log('🔔 [securityGuardCreate] processing invite item keys:', Object.keys(item || {}));
        const entry = await normalizeEntry(item);
        // If frontend provided email/password on the item, forward them to the entry
        if (item) {
          if (item.email) entry.email = entry.email || item.email;
          if (item.password) entry.password = entry.password || item.password;
        }
        if (entry.isDraft) {
          console.log('📄 Creating security guard as draft for guard:', entry.guard);
        }
        const created = await new SecurityGuardService(req).create(entry);

          // If frontend supplied a password while completing an invitation/registration,
          // persist it to the users table, mark email as verified and accept the tenant invitation.
          try {
            if (entry.password) {
              try {
                const BCRYPT_SALT_ROUNDS = 12;
                const hashed = await bcrypt.hash(entry.password, BCRYPT_SALT_ROUNDS);
                await UserRepository.updatePassword(entry.guard, hashed, false, req);
                console.log('🔧 [securityGuardCreate] persisted password for user', entry.guard);
              } catch (pwErr) {
                console.warn('🔔 [securityGuardCreate] failed to persist password for user', entry && entry.guard, pwErr && (pwErr as any).message ? (pwErr as any).message : pwErr);
              }

              try {
                await UserRepository.markEmailVerified(entry.guard, req);
                console.log('🔧 [securityGuardCreate] marked emailVerified for user', entry.guard);
              } catch (evErr) {
                console.warn('🔔 [securityGuardCreate] failed to mark emailVerified for user', entry && entry.guard, evErr && (evErr as any).message ? (evErr as any).message : evErr);
              }
            }

            const tokenToAccept = entry._invitationToken || (incoming && incoming._invitationToken) || null;
            if (tokenToAccept) {
              try {
                await TenantUserRepository.acceptInvitation(tokenToAccept, req);
                console.log('✅ [securityGuardCreate] accepted invitation token for user', entry.guard);
              } catch (accErr) {
                console.warn('🔔 [securityGuardCreate] failed to accept invitation token', tokenToAccept, accErr && (accErr as any).message ? (accErr as any).message : accErr);
              }
            }
          } catch (e) {
            console.warn('🔔 [securityGuardCreate] post-create user persistence step failed', e && (e as any).message ? (e as any).message : e);
          }

        // If frontend supplied a password while completing an invitation/registration,
        // persist it to the users table, mark email as verified and accept the tenant invitation.
        try {
          if (entry.password) {
            try {
              const BCRYPT_SALT_ROUNDS = 12;
              const hashed = await bcrypt.hash(entry.password, BCRYPT_SALT_ROUNDS);
              await UserRepository.updatePassword(entry.guard, hashed, false, req);
              console.log('🔧 [securityGuardCreate] persisted password for user', entry.guard);
            } catch (pwErr) {
              console.warn('🔔 [securityGuardCreate] failed to persist password for user', entry && entry.guard, pwErr && (pwErr as any).message ? (pwErr as any).message : pwErr);
            }

            try {
              await UserRepository.markEmailVerified(entry.guard, req);
              console.log('🔧 [securityGuardCreate] marked emailVerified for user', entry.guard);
            } catch (evErr) {
              console.warn('🔔 [securityGuardCreate] failed to mark emailVerified for user', entry && entry.guard, evErr && (evErr as any).message ? (evErr as any).message : evErr);
            }
          }

          // If there's an invitation token associated with this entry, accept it now so tenant_user
          // moves to active and invitationToken is cleared.
          const tokenToAccept = entry._invitationToken || (item && item._invitationToken) || null;
          if (tokenToAccept) {
            try {
              await TenantUserRepository.acceptInvitation(tokenToAccept, req);
              console.log('✅ [securityGuardCreate] accepted invitation token for user', entry.guard);
            } catch (accErr) {
              console.warn('🔔 [securityGuardCreate] failed to accept invitation token', tokenToAccept, accErr && (accErr as any).message ? (accErr as any).message : accErr);
            }
          }
        } catch (e) {
          console.warn('🔔 [securityGuardCreate] post-create user persistence step failed', e && (e as any).message ? (e as any).message : e);
        }

        // Invitation email is sent by SecurityGuardService.create to keep
        // notification logic centralized; skip sending here to avoid duplicates.

        // Resolve current tenantUser status to reflect activation if invitation was accepted
        let tenantUserStatus = null;
        try {
          const tUser = await TenantUserRepository.findByTenantAndUser(req.params.tenantId, entry.guard, req);
          tenantUserStatus = tUser ? tUser.status : null;
        } catch (e) {
          // ignore
        }

        results.push({ record: created, invitationToken: null });
      }
      payload = results;
    } else {
      const entry = await normalizeEntry(incoming);
      // Forward top-level incoming email/password into the entry so service can set user password
      if (incoming) {
        if (incoming.email) entry.email = entry.email || incoming.email;
        if (incoming.password) entry.password = entry.password || incoming.password;
      }
      if (entry.isDraft) {
        console.log('📄 Creating security guard as draft for guard:', entry.guard);
      }
      const created = await new SecurityGuardService(req).create(entry);

      // Invitation email is sent by SecurityGuardService.create; skip here.

      // Resolve tenantUser status for response
      let tenantUserStatus = null;
      try {
        const tUser = await TenantUserRepository.findByTenantAndUser(req.params.tenantId, entry.guard, req);
        tenantUserStatus = tUser ? tUser.status : null;
      } catch (e) {
        // ignore
      }

      payload = { record: created, invitationToken: null, tenantUserStatus };
    }

    // Restore original actor/tenant and cleanup impersonation flags
    try {
      if (typeof originalCurrentUser !== 'undefined') req.currentUser = originalCurrentUser;
      if (typeof originalCurrentTenant !== 'undefined') req.currentTenant = originalCurrentTenant;
      if (req && req.allowSelfRoleUpdate) delete req.allowSelfRoleUpdate;
    } catch (e) {
      // ignore restore errors
    }
    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    // Ensure we restore original request state on error as well
    try {
      if (typeof originalCurrentUser !== 'undefined') req.currentUser = originalCurrentUser;
      if (typeof originalCurrentTenant !== 'undefined') req.currentTenant = originalCurrentTenant;
      if (req && req.allowSelfRoleUpdate) delete req.allowSelfRoleUpdate;
    } catch (e) {}
    await ApiResponseHandler.error(req, res, error);
  }
};
