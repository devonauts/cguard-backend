import ApiResponseHandler from '../apiResponseHandler';
import SecurityGuardService from '../../services/securityGuardService';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import UserRepository from '../../database/repositories/userRepository';
import bcrypt from 'bcryptjs';

export default async (req, res, next) => {
  // Public creation endpoint for invitation flows. Does NOT require PermissionChecker.
  // It will impersonate the invited tenantUser when an invitation token is provided
  // and then delegate to SecurityGuardService.create. It will NOT accept the
  // invitation here (that should occur when the guard completes registration).
  let originalCurrentUser;
  let originalCurrentTenant;
  try {
    originalCurrentUser = req.currentUser;
    originalCurrentTenant = req.currentTenant;

    const _incomingRaw = req.body && req.body.data ? req.body.data : req.body;
    const providedToken = (_incomingRaw && (_incomingRaw.token || _incomingRaw.invitationToken)) || (req.body && (req.body.token || req.body.invitationToken)) || (req.query && (req.query.token || req.query.invitationToken));

    console.log('🔔 [securityGuardPublicCreate] received public create request', { providedToken: !!providedToken });

    let impersonatedTenantUser: any = null;
    const db = req.database || (req.app && req.app.locals && req.app.locals.database);
    // Log token and securityGuardId values for debugging mismatches
    try {
      const rawToken = (req.body && (req.body.token || req.body.invitationToken)) || (req.query && (req.query.token || req.query.invitationToken)) || null;
      const rawSecId = (req.body && (req.body.securityGuardId || req.body.security_guard_id)) || (req.query && req.query.securityGuardId) || (req.body && req.body.guard) || null;
      console.debug('🔔 [securityGuardPublicCreate] debug values', { rawToken, rawSecId });
    } catch (e) {
      // ignore logging errors
    }

    if (providedToken) {
      try {
        const tenantUser = await TenantUserRepository.findByInvitationToken(
          providedToken,
          req,
        );
        console.log('🔔 [securityGuardPublicCreate] tenantUser lookup result:', !!tenantUser);
        if (tenantUser) {
          req.currentUser = tenantUser.user;
          req.currentTenant = tenantUser.tenant;
          impersonatedTenantUser = tenantUser;
          try { req.allowSelfRoleUpdate = true; } catch (e) {}
          console.log('🔐 [securityGuardPublicCreate] invited flow: impersonated user id', req.currentUser && req.currentUser.id);
        }
        else {
          // Token was provided but no tenantUser found — try fallback using securityGuardId
          console.warn('🔔 [securityGuardPublicCreate] provided token but no tenantUser found; attempting fallback');
          const secGuardId = (req.body && (req.body.securityGuardId || req.body.security_guard_id)) || (req.query && req.query.securityGuardId) || (req.body && req.body.guard) || null;
          if (secGuardId && db) {
            // attempt to locate securityGuard record by id or guardId
            const whereClause: any = { id: secGuardId };
            let record = await db.securityGuard.findOne({ where: whereClause });
            if (!record) {
              // try by guardId
              const whereClauseGuard: any = { guardId: secGuardId };
              record = await db.securityGuard.findOne({ where: whereClauseGuard });
            }
            if (record) {
              try {
                const tenantRec = await db.tenant.findByPk(record.tenantId);
                const guardUser = await db.user.findByPk(record.guardId);
                if (tenantRec && guardUser) {
                  // try to find associated tenantUser row for that tenant and user
                  try {
                    const tenantUserFallback = await TenantUserRepository.findByTenantAndUser(tenantRec.id, guardUser.id, req);
                    if (tenantUserFallback) {
                      req.currentUser = tenantUserFallback.user;
                      req.currentTenant = tenantUserFallback.tenant;
                      impersonatedTenantUser = tenantUserFallback;
                      try { req.allowSelfRoleUpdate = true; } catch (e) {}
                      console.log('🔐 [securityGuardPublicCreate] fallback: impersonated user id', req.currentUser && req.currentUser.id);
                    } else {
                      // If no tenantUser row, still set currentTenant and currentUser to allow creation scoped to tenant
                      req.currentUser = guardUser;
                      req.currentTenant = tenantRec;
                      impersonatedTenantUser = { user: guardUser, tenant: tenantRec, invitationToken: providedToken } as any;
                      try { req.allowSelfRoleUpdate = true; } catch (e) {}
                      console.log('🔐 [securityGuardPublicCreate] fallback: set currentTenant/currentUser from securityGuard record');
                    }
                  } catch (e: any) {
                    console.warn('🔔 [securityGuardPublicCreate] fallback tenantUser lookup failed', e && (e.message || e));
                  }
                }
              } catch (e: any) {
                console.warn('🔔 [securityGuardPublicCreate] fallback securityGuard lookup failed', e && (e.message || e));
              }
            }
          }
          // If still no impersonation, return clear error
          if (!impersonatedTenantUser) {
            try {
              if (typeof originalCurrentUser !== 'undefined') req.currentUser = originalCurrentUser;
              if (typeof originalCurrentTenant !== 'undefined') req.currentTenant = originalCurrentTenant;
              if (req && req.allowSelfRoleUpdate) delete req.allowSelfRoleUpdate;
            } catch (e) {}
            return await ApiResponseHandler.error(req, res, new Error('Invalid invitation token'));
          }
        }
      } catch (e: any) {
        console.warn('🔔 [securityGuardPublicCreate] findByInvitationToken failed', e && (e.message || e));
      }
    }

    let incoming = _incomingRaw;
    // Support body wrapped as { entries: [...] }
    if (incoming && incoming.entries && Array.isArray(incoming.entries)) {
      incoming = incoming.entries[0];
    }

    if (!incoming) {
      throw new Error('Empty payload');
    }

    // If impersonated, ensure guard id is set to the impersonated user
    if ((!incoming || !incoming.guard) && impersonatedTenantUser) {
      incoming = incoming || {};
      incoming.guard = impersonatedTenantUser.user.id;
      incoming._invitationToken = incoming._invitationToken || impersonatedTenantUser.invitationToken || null;
    }

    // Normalize guard identifiers: accept object shapes or guardId aliases
    try {
      if (incoming && incoming.guard && typeof incoming.guard === 'object') {
        incoming.guard = incoming.guard.id || incoming.guard._id || incoming.guard.userId || null;
      }
      if ((!incoming || !incoming.guard) && incoming && (incoming.guardId || incoming.securityGuardId)) {
        incoming.guard = incoming.guardId || incoming.securityGuardId || null;
      }
    } catch (normErr: any) {
      console.warn('🔔 [securityGuardPublicCreate] failed to normalize incoming.guard', normErr && (normErr.message || normErr));
    }

    // Delegate to service
    let created;
    try {
      // Debug: log impersonation context and incoming payload to diagnose failures
      try {
        console.debug('🔔 [securityGuardPublicCreate] before create — impersonatedTenantUser:', impersonatedTenantUser ? { tenantId: impersonatedTenantUser.tenant && impersonatedTenantUser.tenant.id, userId: impersonatedTenantUser.user && impersonatedTenantUser.user.id, invitationToken: impersonatedTenantUser.invitationToken } : null);
        console.debug('🔔 [securityGuardPublicCreate] request currentUser/currentTenant:', { currentUserId: req.currentUser && req.currentUser.id, currentTenantId: req.currentTenant && req.currentTenant.id });
        console.debug('🔔 [securityGuardPublicCreate] incoming payload keys:', Object.keys(incoming || {}));
      } catch (lg) {
        // ignore logging errors
      }
      created = await new SecurityGuardService(req).create(incoming);

      // If incoming provided email or phone and the user record lacks them, persist them
      try {
        const guardId = incoming && incoming.guard ? incoming.guard : (created && (created.guard || created.guardId)) || (impersonatedTenantUser && impersonatedTenantUser.user && impersonatedTenantUser.user.id);
        if (guardId) {
          try {
            const existingUser = await UserRepository.findById(guardId, req);

            // Persist email when provided and not yet present on user
            if (incoming && incoming.email && (!existingUser || !existingUser.email)) {
              try {
                await UserRepository.changeEmail(guardId, incoming.email, req);
                console.log('🔧 [securityGuardPublicCreate] persisted email for user', guardId);
              } catch (emailErr) {
                console.warn('🔔 [securityGuardPublicCreate] failed to persist email for user', guardId, emailErr && (emailErr as any).message ? (emailErr as any).message : emailErr);
              }
            }

            // Persist phone when provided and not yet present on user
            if (incoming && (incoming.phoneNumber || incoming.phone) && (!existingUser || !existingUser.phoneNumber)) {
              const phoneToSave = incoming.phoneNumber || incoming.phone;
              try {
                await UserRepository.patchUpdate(guardId, { phoneNumber: phoneToSave }, req);
                console.log('🔧 [securityGuardPublicCreate] persisted phoneNumber for user', guardId);
              } catch (phoneErr) {
                console.warn('🔔 [securityGuardPublicCreate] failed to persist phoneNumber for user', guardId, phoneErr && (phoneErr as any).message ? (phoneErr as any).message : phoneErr);
              }
            }
          } catch (fetchErr) {
            console.warn('🔔 [securityGuardPublicCreate] could not load user to persist contact info', guardId, fetchErr && (fetchErr as any).message ? (fetchErr as any).message : fetchErr);
          }
        }

        // If incoming included a password (invitation completion), ensure it's persisted
        if (incoming && incoming.password && guardId) {
          try {
            const BCRYPT_SALT_ROUNDS = 12;
            const hashed = await bcrypt.hash(incoming.password, BCRYPT_SALT_ROUNDS);
            await UserRepository.updatePassword(guardId, hashed, false, req);
            console.log('🔧 [securityGuardPublicCreate] persisted password for user', guardId);
          } catch (pwErr) {
            console.warn('🔔 [securityGuardPublicCreate] failed to persist password for user', guardId, pwErr && (pwErr as any).message ? (pwErr as any).message : pwErr);
          }

          try {
            await UserRepository.markEmailVerified(guardId, req);
            console.log('🔧 [securityGuardPublicCreate] marked emailVerified for user', guardId);
          } catch (evErr) {
            console.warn('🔔 [securityGuardPublicCreate] failed to mark emailVerified for user', guardId, evErr && (evErr as any).message ? (evErr as any).message : evErr);
          }

          const tokenToAccept = incoming._invitationToken || providedToken || null;
          if (tokenToAccept) {
            try {
              await TenantUserRepository.acceptInvitation(tokenToAccept, req);
              console.log('✅ [securityGuardPublicCreate] accepted invitation token for user', guardId);
            } catch (accErr) {
              console.warn('🔔 [securityGuardPublicCreate] failed to accept invitation token', tokenToAccept, accErr && (accErr as any).message ? (accErr as any).message : accErr);
            }
          }
        }
      } catch (e) {
        console.warn('🔔 [securityGuardPublicCreate] post-create password persistence step failed', e && (e as any).message ? (e as any).message : e);
      }
    } catch (svcErr: any) {
      console.error('🔴 [securityGuardPublicCreate] SecurityGuardService.create failed:', svcErr instanceof Error && svcErr.stack ? svcErr.stack : svcErr);
      throw svcErr;
    }

    // Return created record (service already handles password/email persistence when appropriate)
    try {
      if (typeof originalCurrentUser !== 'undefined') req.currentUser = originalCurrentUser;
      if (typeof originalCurrentTenant !== 'undefined') req.currentTenant = originalCurrentTenant;
      if (req && req.allowSelfRoleUpdate) delete req.allowSelfRoleUpdate;
    } catch (e) {}

    await ApiResponseHandler.success(req, res, { record: created });
  } catch (error) {
    try {
      if (typeof originalCurrentUser !== 'undefined') req.currentUser = originalCurrentUser;
      if (typeof originalCurrentTenant !== 'undefined') req.currentTenant = originalCurrentTenant;
      if (req && req.allowSelfRoleUpdate) delete req.allowSelfRoleUpdate;
    } catch (e) {}
    console.error('🔴 [securityGuardPublicCreate] handler error:', error instanceof Error ? error.stack : error);
    await ApiResponseHandler.error(req, res, error);
  }
};
