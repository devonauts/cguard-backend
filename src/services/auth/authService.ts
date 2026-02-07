import UserRepository from '../../database/repositories/userRepository';
import Error400 from '../../errors/Error400';
import bcrypt from 'bcryptjs';
import EmailSender from '../../services/emailSender';
import jwt from 'jsonwebtoken';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import { getConfig } from '../../config';
import TenantService from '../tenantService';
import TenantRepository from '../../database/repositories/tenantRepository';
import { tenantSubdomain } from '../tenantSubdomain';
import Error401 from '../../errors/Error401';
import dayjs from 'dayjs';
import Roles from '../../security/roles';
import RoleRepository from '../../database/repositories/roleRepository';

const BCRYPT_SALT_ROUNDS = 12;

class AuthService {

  static async signup(
    email,
    password,
    invitationToken,
    tenantId,
    options: any = {},
  ) {

    const transaction = await SequelizeRepository.createTransaction(
      options.database,
    );

    try {
      email = email.toLowerCase();

      const existingUser = await UserRepository.findByEmail(
        email,
        options,
      );

      // Generates a hashed password to hide the original one.
      const hashedPassword = await bcrypt.hash(
        password,
        BCRYPT_SALT_ROUNDS,
      );

      // The user may already exist on the database in case it was invided.
      if (existingUser) {
        // If the user already have an password,
        // it means that it has already signed up
        const existingPassword = await UserRepository.findPassword(
          existingUser.id,
          options,
        );

        if (existingPassword) {
          throw new Error400(
            options.language,
            'auth.emailAlreadyInUse',
          );
        }

        /**
         * In the case of the user exists on the database (was invited)
         * it only creates the new password
         */
        await UserRepository.updatePassword(
          existingUser.id,
          hashedPassword,
          false,
          {
            ...options,
            transaction,
            bypassPermissionValidation: true,
          },
        );

        // If frontend provided an emailVerificationToken, try to verify email
        try {
          const body = options && options.body ? options.body : {};
          const providedEmailToken = body.emailVerificationToken;
          if (providedEmailToken) {
            await this.verifyEmail(providedEmailToken, {
              ...options,
              transaction,
              currentUser: existingUser,
              bypassPermissionValidation: true,
            });
          }
        } catch (err) {
          // Do not block signup if verification fails here; continue to onboarding
          const errMsg =
            err && typeof err === 'object' && 'message' in err
              ? (err as any).message
              : String(err);
          console.warn('Email auto-verify during signup failed:', errMsg);
        }

        // Handles onboarding process like
        // invitation, creation of default tenant,
        // or default joining the current tenant
        await this.handleOnboard(
          existingUser,
          invitationToken,
          tenantId,
          {
            ...options,
            transaction,
          },
        );

        // Email may have been alreadyverified using the invitation token
        const isEmailVerified = Boolean(
          await UserRepository.count(
            {
              emailVerified: true,
              id: existingUser.id,
            },
            {
              ...options,
              transaction,
            },
          ),
        );

        if (!isEmailVerified) {
          if (EmailSender.isConfigured) {
            console.log('📤 [Signup] Enviando email de verificación...');
            await this.sendEmailAddressVerificationEmail(
              options.language,
              existingUser.email,
              tenantId,
              {
                ...options,
                transaction,
                bypassPermissionValidation: true,
              },
            );
          } else {
            console.log('⚠️ [Signup] EmailSender no configurado, generando token de todas formas...');
            const token = await UserRepository.generateEmailVerificationToken(
              existingUser.email,
              {
                ...options,
                transaction,
                bypassPermissionValidation: true,
              },
            );
          }
        }

        const token = jwt.sign(
          { id: existingUser.id },
          getConfig().AUTH_JWT_SECRET,
          { expiresIn: getConfig().AUTH_JWT_EXPIRES_IN },
        );

        await SequelizeRepository.commitTransaction(
          transaction,
        );

        return token;
      }

      const body = options && options.body ? options.body : {};

      const createData: any = {
        id: body.id || undefined,
        fullName: body.fullName ?? undefined,
        firstName: body.firstName || email.split('@')[0],
        lastName: body.lastName ?? null,
        phoneNumber: body.phoneNumber ?? null,
        importHash: body.importHash ?? null,
        email: email,
        password: hashedPassword,
        emailVerified: typeof body.emailVerified !== 'undefined' ? body.emailVerified : false,
        emailVerificationToken: body.emailVerificationToken ?? null,
        emailVerificationTokenExpiresAt: body.emailVerificationTokenExpiresAt ?? null,
        provider: body.provider ?? null,
        providerId: body.providerId ?? null,
        passwordResetToken: body.passwordResetToken ?? null,
        passwordResetTokenExpiresAt: body.passwordResetTokenExpiresAt ?? null,
        jwtTokenInvalidBefore: body.jwtTokenInvalidBefore ?? null,
      };

      console.log('📥 Creating new user with data keys:', Object.keys(createData));

      const newUser = await UserRepository.createFromAuth(
        createData,
        {
          ...options,
          transaction,
        },
      );

      // If frontend provided an emailVerificationToken, try to verify email for the newly created user
      try {
        const providedEmailToken = body.emailVerificationToken;
        if (providedEmailToken) {
          await this.verifyEmail(providedEmailToken, {
            ...options,
            transaction,
            currentUser: newUser,
            bypassPermissionValidation: true,
          });
        }
      } catch (err) {
        // Do not block signup if verification fails here; continue to onboarding
        const errMsg =
          err && typeof err === 'object' && 'message' in err
            ? (err as any).message
            : String(err);
        console.warn('Email auto-verify during signup failed for new user:', errMsg);
      }

      // Handles onboarding process like
      // invitation, creation of default tenant,
      // or default joining the current tenant
      await this.handleOnboard(
        newUser,
        invitationToken,
        tenantId,
        {
          ...options,
          transaction,
        },
      );

      // Email may have been alreadyverified using the invitation token
      const isEmailVerified = Boolean(
        await UserRepository.count(
          {
            emailVerified: true,
            id: newUser.id,
          },
          {
            ...options,
            transaction,
          },
        ),
      );



      if (!isEmailVerified) {
        if (EmailSender.isConfigured) {
          console.log('📤 [Signup] Enviando email de verificación...');
          await this.sendEmailAddressVerificationEmail(
            options.language,
            newUser.email,
            tenantId,
            {
              ...options,
              transaction,
            },
          );
        } else {
          const token = await UserRepository.generateEmailVerificationToken(
            newUser.email,
            {
              ...options,
              transaction,
              bypassPermissionValidation: true,
            },
          );
        }
      }

      const token = jwt.sign(
        { id: newUser.id },
        getConfig().AUTH_JWT_SECRET,
        { expiresIn: getConfig().AUTH_JWT_EXPIRES_IN },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return token;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      throw error;
    }
  }

  static async findByEmail(email, options: any = {}) {
    email = email.toLowerCase();
    return UserRepository.findByEmail(email, options);
  }

  static async signin(
    email,
    password,
    invitationToken,
    tenantId,
    options: any = {},
  ) {
    const transaction = await SequelizeRepository.createTransaction(
      options.database,
    )
    let committed = false;
    try {
      email = email.toLowerCase()

      const user = await UserRepository.findByEmail(email, options)
      if (!user) {
        throw new Error400(options.language, 'auth.userNotFound')
      }

      const currentPassword = await UserRepository.findPassword(user.id, options)
      if (!currentPassword) {
        throw new Error400(options.language, 'auth.wrongPassword')
      }

      const passwordsMatch = await bcrypt.compare(password, currentPassword)
      if (!passwordsMatch) {
        throw new Error400(options.language, 'auth.wrongPassword')
      }

      if (!user.emailVerified) {
        if (EmailSender.isConfigured) {
          await this.sendEmailAddressVerificationEmail(
            options.language,
            user.email,
            tenantId,
            { ...options, transaction, bypassPermissionValidation: true },
          )
        }
        throw new Error400(options.language, 'auth.emailNotVerified')
      }

      await this.handleOnboard(
        user,
        invitationToken,
        tenantId,
        { ...options, currentUser: user, transaction },
      )

      // token creation will occur after loading `fullUser` to determine tenant context

      // Mark user last login timestamp
      try {
        await UserRepository.markLoggedIn(user.id, {
          ...options,
          transaction,
        });
      } catch (err) {
        console.warn('Could not mark lastLoginAt for user:', err);
      }

      await SequelizeRepository.commitTransaction(transaction)
      committed = true;

      // Load full user with tenant relations and compute tenant permissions
      // Use a loose type to avoid TS narrowing issues when fullUser is assigned later
      let fullUser: any = null;
      try {
        fullUser = await UserRepository.findById(user.id, {
          ...options,
          bypassPermissionValidation: true,
        });
      } catch (err) {
        // If reading the full user fails, fall back to minimal safe user
        const errMsg = err && typeof err === 'object' && 'message' in err
          ? (err as any).message
          : String(err);
        console.warn('Could not load full user during signin response enrichment:', errMsg);
      }

      // Fallback: if fullUser was not loaded or has no tenants, try loading
      // tenant-user rows directly so signin can return tenant information.
      try {
        if (!fullUser || !Array.isArray(fullUser.tenants) || fullUser.tenants.length === 0) {
          const tenantUsers = await TenantUserRepository.findByUser(user.id, {
            ...options,
            bypassPermissionValidation: true,
          });

          if (Array.isArray(tenantUsers) && tenantUsers.length) {
            fullUser = fullUser || {};
            // Map tenantUser records to the shape expected by the rest of the signin flow
            fullUser.tenants = tenantUsers.map((tu: any) => ({
              id: tu.id,
              tenantId: tu.tenantId,
              tenant: tu.tenant || null,
              roles: tu.roles || [],
              permissions: tu.permissions || [],
              assignedClients: tu.assignedClients || [],
              assignedPostSites: tu.assignedPostSites || [],
              status: tu.status || null,
            }));
          }
        }
      } catch (e) {
        console.warn('Could not load tenant-user fallback during signin:', e && (e as any).message ? (e as any).message : e);
      }

      if (fullUser && Array.isArray(fullUser.tenants) && options && options.database) {
        for (const t of fullUser.tenants) {
          try {
            const tenantId = (t && (t.tenantId || (t.tenant && t.tenant.id))) ? (t.tenantId || t.tenant.id) : null;
            if (!tenantId) continue;
            const roleMap = await RoleRepository.getPermissionsMapForTenant(tenantId, { database: options.database });
            const perms = new Set();
            if (Array.isArray(t.roles)) {
              for (const r of t.roles) {
                const rp = roleMap && roleMap[r] ? roleMap[r] : [];
                if (Array.isArray(rp)) rp.forEach((p) => perms.add(p));
              }
            }
            // Attach computed permissions array to the tenant entry
            t.permissions = Array.from(perms);
            } catch (e) {
            // non-fatal per-tenant
            const tenantPermsWarnMsg = e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e);
            console.warn('Could not compute tenant permissions for signin response', tenantPermsWarnMsg);
            t.permissions = t.permissions || [];
          }
        }
      }

      const safeUser = fullUser
        ? {
            id: fullUser.id,
            email: fullUser.email,
            firstName: fullUser.firstName || null,
            lastName: fullUser.lastName || null,
            tenants: (fullUser.tenants || []).map((t) => ({
              id: t.id,
              tenantId: t.tenantId,
              tenant: t.tenant || null,
              roles: t.roles || [],
              permissions: t.permissions || [],
              assignedClients: t.assignedClients || [],
              assignedPostSites: t.assignedPostSites || [],
              status: t.status || null,
            })),
          }
        : {
            id: user.id,
            email: user.email,
            firstName: user.firstName || null,
            lastName: user.lastName || null,
          };

      // Transform `safeUser.tenants` (array) into single `tenant` object
      try {
        const tenantEntries = (safeUser && Array.isArray((safeUser as any).tenants)) ? (safeUser as any).tenants : [];
        if (tenantEntries.length === 0) {
          // No tenant assigned: allow signin but return a token without tenantId and
          // keep `tenant` as null so frontend can show a restricted dashboard.
          (safeUser as any).tenant = null;
          delete (safeUser as any).tenants;

          const finalToken = jwt.sign(
            { id: user.id },
            getConfig().AUTH_JWT_SECRET,
            { expiresIn: getConfig().AUTH_JWT_EXPIRES_IN },
          );

          return { token: finalToken, user: safeUser };
        }

        if (tenantEntries.length > 1) {
          throw new Error('auth.multipleTenantsNotAllowed');
        }

        const tenantEntry = tenantEntries[0];
        const tenantIdForToken = tenantEntry.tenantId || (tenantEntry.tenant && tenantEntry.tenant.id) || null;

        // Replace tenants array with single `tenant` key containing the tenant info + roles/permissions
        (safeUser as any).tenant = {
          tenantId: tenantEntry.tenantId,
          tenant: tenantEntry.tenant || null,
          roles: tenantEntry.roles || [],
          permissions: tenantEntry.permissions || [],
          assignedClients: tenantEntry.assignedClients || [],
          assignedPostSites: tenantEntry.assignedPostSites || [],
          status: tenantEntry.status || null,
        };
        delete (safeUser as any).tenants;

        const finalToken = jwt.sign(
          { id: user.id, tenantId: tenantIdForToken },
          getConfig().AUTH_JWT_SECRET,
          { expiresIn: getConfig().AUTH_JWT_EXPIRES_IN },
        );

        return { token: finalToken, user: safeUser };
      } catch (err) {
        if (!committed) {
          await SequelizeRepository.rollbackTransaction(transaction);
        }
        throw new Error400(options.language, (err && (err as any).message) || 'auth.invalidTenantConfiguration');
      }
    } catch (error) {
      if (!committed) {
        await SequelizeRepository.rollbackTransaction(transaction)
      }
      throw error
    }
  }


  static async handleOnboard(
    currentUser,
    invitationToken,
    tenantId,
    options,
  ) {
    if (invitationToken) {
      try {
        await TenantUserRepository.acceptInvitation(
          invitationToken,
          {
            ...options,
            currentUser,
            bypassPermissionValidation: true,
          },
        );
      } catch (error) {
        console.error(error);
        // In case of invitation acceptance error, does not prevent
        // the user from sign up/in
      }
    }

    const isMultiTenantViaSubdomain =
      ['multi', 'multi-with-subdomain'].includes(
        getConfig().TENANT_MODE,
      ) && tenantId;

    if (isMultiTenantViaSubdomain) {
      await new TenantService({
        ...options,
        currentUser,
      }).joinWithDefaultRolesOrAskApproval(
        {
          tenantId,
          // Assign admin role for new users in multi-tenant mode
          roles: [Roles.values.admin],
        },
        options,
      );
    }

    const singleTenant =
      getConfig().TENANT_MODE === 'single';

    if (singleTenant) {
      // In case is single tenant, and the user is signing in
      // with an invited email and for some reason doesn't have the token
      // it auto-assigns it
      await new TenantService({
        ...options,
        currentUser,
      }).joinDefaultUsingInvitedEmail(options.transaction);

      // Creates or join default Tenant
      await new TenantService({
        ...options,
        currentUser,
      }).createOrJoinDefault(
        {
          // Assign admin role for the first user of the tenant
          roles: [Roles.values.admin],
        },
        options.transaction,
      );
    }
  }

  static async findByToken(token, options) {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        getConfig().AUTH_JWT_SECRET,
        (err, decoded) => {
          if (err) {
            reject(err);
            return;
          }

          const id = decoded?.id;
          const jwtTokenIat = decoded.iat;
          const tokenTenantId = decoded?.tenantId;

          UserRepository.findById(id, {
            ...options,
            bypassPermissionValidation: true,
          })
            .then(async (user) => {
              const isTokenManuallyExpired =
                user &&
                user.jwtTokenInvalidBefore &&
                dayjs
                  .unix(jwtTokenIat)
                  .isBefore(
                    dayjs(user.jwtTokenInvalidBefore),
                  );

              if (isTokenManuallyExpired) {
                reject(new Error401());
                return;
              }

              // If the email sender id not configured,
              // removes the need for email verification.
              if (user && !EmailSender.isConfigured) {
                user.emailVerified = true;
              }

              // If the token contains a tenantId, load and attach the tenant
              // to the request/options so downstream code has a clear tenant context.
              try {
                if (tokenTenantId && options) {
                  try {
                    const tenant = await TenantRepository.findById(tokenTenantId, { ...options });
                    if (!tenant) {
                      reject(new Error401());
                      return;
                    }
                    // Validate that the user belongs to that tenant
                    const userTenantIds = (user && Array.isArray(user.tenants))
                      ? user.tenants.map((t) => (t && (t.tenantId || (t.tenant && t.tenant.id))) ? (t.tenantId || t.tenant.id) : null).filter(Boolean)
                      : [];
                    if (!userTenantIds.includes(tokenTenantId)) {
                      reject(new Error401());
                      return;
                    }
                    // Attach to options so middlewares can use it
                    try {
                      (options as any).currentTenant = tenant;
                    } catch (e) {
                      // ignore attach errors
                    }
                  } catch (e) {
                    // If tenant lookup fails, reject
                    reject(new Error401());
                    return;
                  }
                }

                // Prime role permissions cache for the user's tenants so
                // synchronous permission checks can consult the in-memory cache.
                try {
                  const tenantIds = (user && Array.isArray(user.tenants))
                    ? user.tenants.map((t) => (t && t.id) ? t.id : null).filter(Boolean)
                    : [];
                  if (tenantIds.length && options && options.database) {
                    tenantIds.forEach((tid) => {
                      RoleRepository.getPermissionsMapForTenant(tid, { database: options.database })
                        .catch((err) => {
                          try {
                            console.warn('RoleRepository cache priming failed for tenant', tid, err && err.message ? err.message : err);
                          } catch (e) {
                            // ignore
                          }
                        });
                    });
                  }
                } catch (e) {
                  // non-fatal
                }
              } catch (e) {
                // non-fatal
              }

                resolve(user);
            })
            .catch((error) => reject(error));
        },
      );
    });
  }

  static async sendEmailAddressVerificationEmail(
    language,
    email,
    tenantId,
    options,
  ) {
    if (!EmailSender.isConfigured) {
      throw new Error400(language, 'email.error');
    }

    let link;
    try {
      let tenant;

      if (tenantId) {
        tenant = await TenantRepository.findById(
          tenantId,
          { ...options },
        );
      }

      email = email.toLowerCase();
      const token = await UserRepository.generateEmailVerificationToken(
        email,
        options,
      );
      link = `${tenantSubdomain.frontendUrl(
        tenant,
      )}/auth/verify-email?token=${token}`;
    } catch (error) {
      console.error(error);
      throw new Error400(
        language,
        'auth.emailAddressVerificationEmail.error',
      );
    }

    return new EmailSender(
      EmailSender.TEMPLATES.EMAIL_ADDRESS_VERIFICATION,
      { link },
    ).sendTo(email);
  }

  static async sendPasswordResetEmail(
    language,
    email,
    tenantId,
    options,
  ) {
    // For development: skip email configuration check
    // if (!EmailSender.isConfigured) {
    //   throw new Error400(language, 'email.error');
    // }

    let link;

    try {
      let tenant;

      if (tenantId) {
        tenant = await TenantRepository.findById(
          tenantId,
          { ...options },
        );
      }

      email = email.toLowerCase();
      const token = await UserRepository.generatePasswordResetToken(
        email,
        options,
      );

      link = `${tenantSubdomain.frontendUrl(
        tenant,
      )}/auth/password-reset?token=${token}`;

      // For development: log the reset link instead of sending email
      if (!EmailSender.isConfigured) {
        return true; // Return success without sending email
      }
    } catch (error) {
      console.error(error);
      throw new Error400(
        language,
        'auth.passwordReset.error',
      );
    }

    return new EmailSender(
      EmailSender.TEMPLATES.PASSWORD_RESET,
      { link },
    ).sendTo(email);
  }

  static async verifyEmail(token, options) {
    const currentUser = options.currentUser;

    const user = await UserRepository.findByEmailVerificationToken(
      token,
      options,
    );

    if (!user) {
      throw new Error400(
        options.language,
        'auth.emailAddressVerificationEmail.invalidToken',
      );
    }

    if (
      currentUser &&
      currentUser.id &&
      currentUser.id !== user.id
    ) {
      throw new Error400(
        options.language,
        'auth.emailAddressVerificationEmail.signedInAsWrongUser',
        user.email,
        currentUser.email,
      );
    }

    return UserRepository.markEmailVerified(
      user.id,
      options,
    );
  }

  static async passwordReset(
    token,
    password,
    options: any = {},
  ) {
    const user = await UserRepository.findByPasswordResetToken(
      token,
      options,
    );

    if (!user) {
      throw new Error400(
        options.language,
        'auth.passwordReset.invalidToken',
      );
    }

    const hashedPassword = await bcrypt.hash(
      password,
      BCRYPT_SALT_ROUNDS,
    );

    return UserRepository.updatePassword(
      user.id,
      hashedPassword,
      true,
      { ...options, bypassPermissionValidation: true },
    );
  }

  static async changePassword(
    oldPassword,
    newPassword,
    options,
  ) {
    const currentUser = options.currentUser;
    const currentPassword = await UserRepository.findPassword(
      options.currentUser.id,
      options,
    );

    const passwordsMatch = await bcrypt.compare(
      oldPassword,
      currentPassword,
    );

    if (!passwordsMatch) {
      throw new Error400(
        options.language,
        'auth.passwordChange.invalidPassword',
      );
    }

    const newHashedPassword = await bcrypt.hash(
      newPassword,
      BCRYPT_SALT_ROUNDS,
    );

    return UserRepository.updatePassword(
      currentUser.id,
      newHashedPassword,
      true,
      options,
    );
  }

  static async signinFromSocial(
    provider,
    providerId,
    email,
    emailVerified,
    firstName,
    lastName,
    options: any = {},
  ) {
    if (!email) {
      throw new Error('auth-no-email');
    }

    const transaction = await SequelizeRepository.createTransaction(
      options.database,
    );

    try {
      email = email.toLowerCase();
      let user = await UserRepository.findByEmail(
        email,
        options,
      );

      if (
        user &&
        (user.provider !== provider ||
          user.providerId !== providerId)
      ) {
        throw new Error('auth-invalid-provider');
      }

      if (!user) {
        user = await UserRepository.createFromSocial(
          provider,
          providerId,
          email,
          emailVerified,
          firstName,
          lastName,
          options,
        );
      }

      const token = jwt.sign(
        { id: user.id },
        getConfig().AUTH_JWT_SECRET,
        { expiresIn: getConfig().AUTH_JWT_EXPIRES_IN },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return token;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        transaction,
      );

      throw error;
    }
  }
}

export default AuthService;
