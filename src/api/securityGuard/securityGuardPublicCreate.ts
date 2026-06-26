import ApiResponseHandler from '../apiResponseHandler';
import SecurityGuardService from '../../services/securityGuardService';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import UserRepository from '../../database/repositories/userRepository';
import InvitationAcceptanceService from '../../services/auth/invitationAcceptanceService';

export default async (req, res, next) => {
  // Public creation endpoint for invitation flows. Does NOT require PermissionChecker.
  // The invitation TOKEN is the ONLY trust anchor: we resolve EXACTLY the
  // tenantUser the token belongs to. There is intentionally NO securityGuardId
  // fallback — a request without a valid, matching token is rejected.
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

    // A token is REQUIRED for this public endpoint. The token alone determines
    // which user/tenant we are allowed to act on; we never resolve identity
    // from a securityGuardId or any other client-supplied id.
    if (!providedToken) {
      return await ApiResponseHandler.error(req, res, Object.assign(new Error('Invalid invitation token'), { code: 400 }));
    }

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
        // Scoped strictly to the token-validated path: the invited guard may
        // not yet have any roles, so we permit assigning the securityGuard role
        // to their own tenantUser row. Gated entirely on a verified token, so
        // no caller can opt into this without proving token ownership.
        try { req.allowSelfRoleUpdate = true; } catch (e) {}
        console.log('🔐 [securityGuardPublicCreate] invited flow: impersonated user id', req.currentUser && req.currentUser.id);
      }
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('🔔 [securityGuardPublicCreate] findByInvitationToken failed', msg);
    }

    // Token was provided but did not resolve to a tenantUser (invalid/expired).
    // Reject — no fallback resolution is permitted.
    if (!impersonatedTenantUser) {
      try {
        if (typeof originalCurrentUser !== 'undefined') req.currentUser = originalCurrentUser;
        if (typeof originalCurrentTenant !== 'undefined') req.currentTenant = originalCurrentTenant;
        if (req && req.allowSelfRoleUpdate) delete req.allowSelfRoleUpdate;
      } catch (e) {}
      return await ApiResponseHandler.error(req, res, Object.assign(new Error('Invalid invitation token'), { code: 400 }));
    }

    let incoming = _incomingRaw;
    // Support body wrapped as { entries: [...] }
    if (incoming && incoming.entries && Array.isArray(incoming.entries)) {
      incoming = incoming.entries[0];
    }

    if (!incoming) {
      throw Object.assign(new Error('Empty payload'), { code: 400 });
    }

    // The guard is ALWAYS the token's user. We never accept a client-supplied
    // guard/guardId/securityGuardId as an identity anchor on this endpoint.
    incoming = incoming || {};
    incoming.guard = impersonatedTenantUser.user.id;
    incoming._invitationToken = impersonatedTenantUser.invitationToken || null;

    // Delegate to service
    let created;
    try {
      // When impersonating via invitation token, requests should be allowed to
      // assign the `securityGuard` role to the impersonated user even if the
      // impersonated user has no existing roles. To avoid privilege escalation
      // protection blocking that action, set `bypassPrivilegeCheck=true` for
      // the duration of this service call only. This is gated on a verified
      // token (impersonatedTenantUser is only set above for a valid token).
      const originalBypass = (req && (req as any).bypassPrivilegeCheck) || false;
      try {
        try { (req as any).bypassPrivilegeCheck = true; } catch (e) {}
        created = await new SecurityGuardService(req).create(incoming);
      } finally {
        try { (req as any).bypassPrivilegeCheck = originalBypass; } catch (e) {}
      }

      // Persist contact info (email/phone) onto the token's user when provided
      // and not yet present. The guard id is the token user's id by construction.
      const guardId = impersonatedTenantUser.user.id;
      try {
        try {
          const existingUser = await UserRepository.findById(guardId, req);

          if (incoming && incoming.email && (!existingUser || !existingUser.email)) {
            try {
              await UserRepository.changeEmail(guardId, incoming.email, req);
              console.log('🔧 [securityGuardPublicCreate] persisted email for user', guardId);
            } catch (emailErr) {
              console.warn('🔔 [securityGuardPublicCreate] failed to persist email for user', guardId, emailErr && (emailErr as any).message ? (emailErr as any).message : emailErr);
            }
          }

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

        // Invitation acceptance (set password, mark email verified, activate the
        // tenant invitation) is delegated to the hardened service. The TOKEN is
        // the sole trust anchor; the service resolves exactly the token's
        // user/tenant and never falls back to securityGuardId.
        await InvitationAcceptanceService.acceptInvitation(db, providedToken, {
          password: incoming && incoming.password,
          language: req.language,
        });
        console.log('✅ [securityGuardPublicCreate] invitation accepted via service for token user', guardId);
      } catch (e) {
        // Surface password-policy / validation errors (Error400) to the caller;
        // swallow only soft/non-fatal persistence warnings.
        if (e && (e as any).code === 400) {
          throw e;
        }
        console.warn('🔔 [securityGuardPublicCreate] post-create invitation acceptance step failed', e && (e as any).message ? (e as any).message : e);
      }
    } catch (svcErr: any) {
      console.error('🔴 [securityGuardPublicCreate] SecurityGuardService.create failed:', svcErr instanceof Error && svcErr.stack ? svcErr.stack : svcErr);
      throw svcErr;
    }

    // Return created record
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
