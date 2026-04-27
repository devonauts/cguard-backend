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
      console.log('[securityGuardPublicFind] token received:', token);
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
            throw new Error('Invalid tenant for invitation');
          }

          if (!user) {
            console.warn('[securityGuardPublicFind] tenantUser exists but user is null');
            throw new Error('Invalid user for invitation');
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

    // Fallback: if token not provided or invalid, allow fetching by securityGuardId
    if (!record && securityGuardId) {
      const tenantIdParam = req.params && req.params.tenantId;

      const whereClause: any = { id: securityGuardId };
      if (tenantIdParam) {
        whereClause.tenantId = tenantIdParam;
      }

      console.log('Searching securityGuard by id:', securityGuardId, 'whereClause:', whereClause);

      record = await db.securityGuard.findOne({
        where: whereClause,
      });

      console.log('securityGuard record found by id:', !!record);

      // If not found by id, try by guardId
      if (!record) {
        const whereClauseGuard: any = { guardId: securityGuardId };
        if (tenantIdParam) {
          whereClauseGuard.tenantId = tenantIdParam;
        }

        console.log('Searching securityGuard by guardId:', securityGuardId, 'whereClause:', whereClauseGuard);

        record = await db.securityGuard.findOne({
          where: whereClauseGuard,
        });

        console.log('securityGuard record found by guardId:', !!record);
      }

      if (record) {
        tenant = await db.tenant.findByPk(record.tenantId);
      }
    }

    if (!record) {
      console.warn('[securityGuardPublicFind] No security guard record found', {
        hasToken: !!token,
        hasSecurityGuardId: !!securityGuardId,
        hasTenantUser: !!tenantUser
      });
      
      // Return a more specific error message
      if (token && !tenantUser && !securityGuardId) {
        const err = new Error('Token de invitación inválido o expirado. Por favor solicita una nueva invitación.');
        err.name = 'InvalidInvitationToken';
        // Mark as client error so ApiResponseHandler returns 400 instead of 500
        (err as any).code = 400;
        return await ApiResponseHandler.error(req, res, err);
      }
      
      throw new Error('No se encontró un registro de guardia para esta invitación o ID');
    }
    
    // Si el guardia ya existe y no es borrador, enviar error especial
    if (record && record.governmentId && record.governmentId !== 'PENDING') {
      console.log('[securityGuardPublicFind] Guard already fully created', {
        guardId: record.id,
        governmentId: record.governmentId
      });
      const err = new Error('El usuario ya fue creado y no puede ser modificado nuevamente.');
      err.name = 'GuardAlreadyCreated';
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

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
