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
      }
    }

    // Fallback: if token not provided or invalid, allow fetching by securityGuardId
    if (!record && securityGuardId) {
      const tenantIdParam = req.params && req.params.tenantId;
      record = await db.securityGuard.findOne({
        where: {
          id: securityGuardId,
          tenantId: tenantIdParam || undefined,
        },
      });

      if (record) {
        tenant = await db.tenant.findByPk(record.tenantId);
      }
    }

    if (!record) {
      throw new Error('No security guard draft found for this invitation or id');
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
        let emailVerificationToken = guardUser.emailVerificationToken;
        if (!emailVerificationToken) {
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
