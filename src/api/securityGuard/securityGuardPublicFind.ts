import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';
import UserRepository from '../../database/repositories/userRepository';

export default async (req, res, next) => {
  try {
    const token = req.query && (req.query.token || req.query.invitationToken);
    const securityGuardId = req.query && req.query.securityGuardId;

    let tenant: any = null;
    let record: any = null;
    let tenantUser: any = null;

    // Prefer the database injected by the middleware (`req.database`).
    // Fallback to `app.locals.database` for backward compatibility.
    const db = req.database || (req.app && req.app.locals && req.app.locals.database);

    if (token) {
      tenantUser = await TenantUserRepository.findByInvitationToken(
        token,
        req,
      );

      console.log('tenantUser found:', !!tenantUser);

      if (!tenantUser) {
        // continue to fallback to securityGuardId if provided
        if (!securityGuardId) {
          throw new Error('Invalid invitation token');
        }
      } else {
        tenant = tenantUser.tenant;
        const user = tenantUser.user;

        if (!tenant) {
          throw new Error('Invalid tenant for invitation');
        }

        // Find draft security guard for this invited user
        record = await db.securityGuard.findOne({
          where: {
            guardId: user.id,
            tenantId: tenant.id,
          },
        });

        console.log('securityGuard record found by guardId:', !!record);
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
      throw new Error('No security guard draft found for this invitation or id');
    }
    // Si el guardia ya existe y no es borrador, enviar error especial
    if (record && record.governmentId && record.governmentId !== 'PENDING') {
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

    // Merge user important fields and ensure emailVerificationToken is present
    try {
      const guardUser = await options.database.user.findByPk(record.guardId);
      if (guardUser) {
        // Only generate email verification token for real emails (not synthetic phone emails)
        let emailVerificationToken: string | null = null;
        if (
          guardUser &&
          guardUser.email &&
          guardUser.provider !== 'phone' &&
          !String(guardUser.email).endsWith('@phone.local')
        ) {
          try {
            emailVerificationToken = await UserRepository.generateEmailVerificationToken(
              guardUser.email,
              req,
            );
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn('Failed to generate emailVerificationToken for public fetch:', errMsg);
          }
        }

        payload.guard = {
          id: guardUser.id,
          firstName: guardUser.firstName || null,
          lastName: guardUser.lastName || null,
          email: guardUser.email,
          phoneNumber: guardUser.phoneNumber || null,
          emailVerificationToken: emailVerificationToken || null,
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
