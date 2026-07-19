import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';
import UserRepository from '../../database/repositories/userRepository';

export default async (req, res, next) => {
  try {
    const token = req.query && (req.query.token || req.query.invitationToken || req.query.invite);
    const securityGuardId = req.query && req.query.securityGuardId;

    let tenant: any = null;
    let record: any = null;
    let tenantUser: any = null;

    // Prefer the database injected by the middleware (`req.database`).
    // Fallback to `app.locals.database` for backward compatibility.
    const db = req.database || (req.app && req.app.locals && req.app.locals.database);

    if (token) {
      console.log('[securityGuardPublicFind] token received:', !!token);
      try {
        tenantUser = await TenantUserRepository.findByInvitationToken(
          token,
          req,
        );

        console.log('[securityGuardPublicFind] tenantUser found:', !!tenantUser);

        if (!tenantUser) {
          console.log('[securityGuardPublicFind] No tenantUser found for token, will try securityGuardId fallback');
          // continue to fallback to securityGuardId if provided
          // Do NOT throw error here - allow fallback to securityGuardId
        } else {
          tenant = tenantUser.tenant;
          const user = tenantUser.user;

          console.log('[securityGuardPublicFind] tenantUser details:', {
            hasTenant: !!tenant,
            hasUser: !!user,
            userId: user ? user.id : null,
            tenantId: tenant ? tenant.id : null
          });

          if (!tenant) {
            console.warn('[securityGuardPublicFind] tenantUser exists but tenant is null');
            throw Object.assign(new Error('Invalid tenant for invitation'), { code: 400 });
          }

          if (!user) {
            console.warn('[securityGuardPublicFind] tenantUser exists but user is null');
            throw Object.assign(new Error('Invalid user for invitation'), { code: 400 });
          }

          // Find draft security guard for this invited user
          record = await db.securityGuard.findOne({
            where: {
              guardId: user.id,
              tenantId: tenant.id,
            },
          });

          console.log('[securityGuardPublicFind] securityGuard record found by guardId:', !!record);
        }
      } catch (err) {
        console.error('[securityGuardPublicFind] Error finding tenantUser by token:', err && (err as any).message ? (err as any).message : err);
        if (err && (err as any).stack) console.error((err as any).stack);
        // If error finding tenantUser, try fallback to securityGuardId
        if (!securityGuardId) {
          throw err;
        }
      }
    }

    // Fallback by securityGuardId — ONLY when a VALID invitation token already
    // resolved the tenant but the draft securityGuard row wasn't found by guardId.
    // A bare securityGuardId lookup WITHOUT a token-verified tenant is forbidden:
    // it previously ran with no tenant constraint (the public route has no
    // :tenantId), leaking any guard's PII cross-tenant by guessing a UUID.
    if (!record && securityGuardId && tenant && tenant.id) {
      record = await db.securityGuard.findOne({
        where: { id: securityGuardId, tenantId: tenant.id },
      });
      if (!record) {
        record = await db.securityGuard.findOne({
          where: { guardId: securityGuardId, tenantId: tenant.id },
        });
      }
    }

    if (!record) {
      console.warn('[securityGuardPublicFind] No security guard record found', {
        hasToken: !!token,
        hasSecurityGuardId: !!securityGuardId,
        hasTenantUser: !!tenantUser
      });
      
      // No record resolved → the invitation is invalid/expired (or the id didn't
      // belong to the token's tenant). Always a 400 client error, never a 500.
      const err: any = new Error('Token de invitación inválido o expirado. Por favor solicita una nueva invitación.');
      err.name = 'InvalidInvitationToken';
      err.code = 400;
      return await ApiResponseHandler.error(req, res, err);
    }
    
    // Si el guardia ya existe y no es borrador, enviar error especial
    if (record && record.governmentId && record.governmentId !== 'PENDING') {
      console.log('[securityGuardPublicFind] Guard already fully created', {
        guardId: record.id,
        governmentId: record.governmentId
      });
      const err: any = new Error('El usuario ya fue creado y no puede ser modificado nuevamente.');
      err.name = 'GuardAlreadyCreated';
      err.code = 400; // user-facing message → 400, not a generic 500
      return await ApiResponseHandler.error(req, res, err);
    }

    const options = {
      currentTenant: tenant || null,
      currentUser: null,
      language: req.language,
      database: db,
    };

    // Fill relations and files
    const payload = await SecurityGuardRepository._fillWithRelationsAndFiles(
      record,
      options,
    );

    // Merge user important fields. Do NOT generate an email verification token
    // during the public invitation fetch — generating the token here causes it
    // to be persisted prematurely and may trigger a verification email.
    // IMPORTANT: Do NOT mark email as verified here either, as that will invalidate
    // the invitation token before the guard completes the registration form.
    // Email verification should only happen when the guard submits the form (POST).
    try {
      const guardUser = await options.database.user.findByPk(record.guardId);
        if (guardUser) {
        // Just load the user info without modifying any verification status
        // The invitation token must remain valid until form submission
        payload.guard = {
          id: guardUser.id,
          firstName: guardUser.firstName || null,
          lastName: guardUser.lastName || null,
          email: guardUser.email,
          phoneNumber: guardUser.phoneNumber || null,
          emailVerificationToken: null,
          emailVerified: guardUser.emailVerified || false,
        };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('Failed to merge guard user info in public fetch:', errMsg);
    }

    // Attach tenantUser invitation token and status so frontend can use it
    try {
      if (tenantUser) {
        payload.invitationToken = tenantUser.invitationToken || null;
        payload.tenantUserStatus = tenantUser.status || null;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('Failed to attach tenantUser info in public fetch:', errMsg);
    }

    // Tenant branding so the registration page can look like the TENANT
    // (its own logo + name), not the platform.
    try {
      if (tenant) {
        payload.tenantId = tenant.id;
        payload.tenantName = tenant.name || tenant.displayName || null;
        try {
          const s = await options.database.settings.findOne({ where: { tenantId: tenant.id } });
          payload.tenantLogoUrl = (s && (s.logoUrl || (s.get && s.get('logoUrl')))) || null;
        } catch (e) { /* no logo */ }
      }
    } catch (err) {
      console.warn('Failed to attach tenant branding in public fetch:', err && (err as any).message ? (err as any).message : err);
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
