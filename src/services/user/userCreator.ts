import assert from 'assert';
import crypto from 'crypto';
import EmailSender from '../../services/emailSender';
import UserRepository from '../../database/repositories/userRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import { tenantSubdomain } from '../tenantSubdomain';
import { IServiceOptions } from '../IServiceOptions';
import Roles from '../../security/roles';
export default class UserCreator {
  options: IServiceOptions;
  transaction;
  data;
  emailsToInvite: Array<any> = [];
  emails: any = [];
  sendInvitationEmails = true;
  sendVerificationEmails = true;

  constructor(options) {
    this.options = options;
  }

  /**
   * Creates new user(s) via the User page.
   * Sends Invitation Emails if flagged.
   */
  async execute(data, sendInvitationEmails = true, sendVerificationEmails?: boolean) {
    // Assign 'customer' role when creating users associated with client accounts
    // and no explicit roles are provided
    let inputData = { ...data };
    const hasClientIds = inputData.clientIds && Array.isArray(inputData.clientIds) && inputData.clientIds.length > 0;
    const hasNoRoles = !inputData.roles || 
                       (Array.isArray(inputData.roles) && inputData.roles.length === 0) ||
                       (typeof inputData.roles === 'string' && inputData.roles.trim() === '');
    
    // If clientIds are provided (user is associated with client accounts),
    // ensure the 'customer' role is assigned so they can log in to the mobile app
    if (hasClientIds && hasNoRoles) {
      inputData.roles = [Roles.values.customer];
    }
    
    this.data = inputData;
    this.sendInvitationEmails = sendInvitationEmails;
    // If caller explicitly passed sendVerificationEmails use it.
    // Otherwise, if invitation emails are suppressed, also suppress verification emails
    // to avoid duplicate emails when higher-level handlers send invitations.
    if (typeof sendVerificationEmails === 'boolean') {
      this.sendVerificationEmails = sendVerificationEmails;
    } else {
      // If invitation emails are being sent, prefer sending only the invitation
      // and skip duplicate email verification messages. If invitation emails are
      // suppressed, send verification emails by default.
      this.sendVerificationEmails = sendInvitationEmails ? false : true;
    }

    await this._validate();

    // Process each email in its own transaction to reduce lock contention
    // across multiple tenant_user/pivot inserts. This changes behavior
    // from a single shared transaction for all emails, but avoids long-lived
    // locks that cause ER_LOCK_WAIT_TIMEOUT in high-concurrency scenarios.
    for (const email of this._emails) {
      // create a new transaction per email and call _addOrUpdate with it
      const tx = await SequelizeRepository.createTransaction(this.options.database);
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._addOrUpdate(email, tx);
        // commit per-email
        // eslint-disable-next-line no-await-in-loop
        await SequelizeRepository.commitTransaction(tx);
      } catch (err) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await SequelizeRepository.rollbackTransaction(tx);
        } catch (rbErr) {
          console.error('Failed to rollback per-email transaction in UserCreator:', rbErr);
        }
        throw err;
      }
    }

    if (this._hasEmailsToInvite) {
      await this._sendAllInvitationEmails();
    }
  }

  get _roles() {
    const raw = this.data && this.data.roles;
    if (!raw) {
      return [];
    }
    if (!Array.isArray(raw)) {
      return [raw];
    }
    return [...new Set(raw)];
  }

  get _emails() {
    const rawEmails =
      this.data && (this.data.emails ?? this.data.email);

    let list: any[] = [];
    if (!rawEmails) {
      list = [];
    } else if (Array.isArray(rawEmails)) {
      list = rawEmails;
    } else {
      list = [rawEmails];
    }

    const uniqueEmails = [...new Set(list)];
    this.emails = uniqueEmails.map((email) =>
      typeof email === 'string' ? email.trim() : email,
    );

    return this.emails;
  }

  /**
   * Creates or updates many users at once.
   */
  async _addOrUpdateAll() {
    // Process sequentially to avoid concurrent writes within the same DB
    // transaction which can cause deadlocks / lock wait timeouts.
    const results: any[] = [];
    for (const email of this.emails) {
      // await each operation so the DB sees a deterministic sequence
      // and avoids competing row/table locks created by parallel inserts.
      // This is important when creating tenant_user and related pivot rows
      // that may contend on the same tenant/user keys.
      // Note: We intentionally do not swallow individual errors here —
      // let the outer transaction handling manage rollback on failure.
      // Collect results for potential later use.
      // eslint-disable-next-line no-await-in-loop
      const r = await this._addOrUpdate(email);
      results.push(r);
    }
    return results;
  }

  /**
   * Creates or updates the user passed.
   * If the user already exists, it only adds the role to the user.
   */
  async _addOrUpdate(email, tx?) {
    let user = await UserRepository.findByEmailWithoutAvatar(
      email,
      {
        ...this.options,
        transaction: tx,
      },
    );

    if (!user) {
      const createData: any = { email };
      // Allow callers to force the created User id (e.g., match clientAccount id)
      // The id can be provided at top-level (`this.data.id`) or inside the per-email
      // object when `this.data.emails` is an array of objects.
      if (this.data && this.data.id) {
        createData.id = this.data.id;
      }

      // If names are provided at top-level, prefer them
      // Accept both English and Spanish field names from clients
      if (this.data.firstName) {
        createData.firstName = this.data.firstName;
      } else if (this.data.nombre) {
        createData.firstName = this.data.nombre;
      }

      if (this.data.lastName) {
        createData.lastName = this.data.lastName;
      } else if (this.data.apellido) {
        createData.lastName = this.data.apellido;
      }

      // fullName may be provided directly; if not, derive from nombre/apellido
      if (this.data.fullName) {
        createData.fullName = this.data.fullName;
      } else if (!createData.fullName && (createData.firstName || createData.lastName)) {
        // Build fullName from available parts
        createData.fullName = [createData.firstName, createData.lastName].filter(Boolean).join(' ').trim() || undefined;
      }

      // Support emails passed as objects: [{ email, firstName, lastName, fullName }, ...]
      if (Array.isArray(this.data.emails)) {
        const matched = this.data.emails.find((e) => {
          if (!e) return false;
          if (typeof e === 'string') return false;
          return (e.email === email) || (e.value === email);
        });
        if (matched && typeof matched === 'object') {
          if (matched.firstName) createData.firstName = matched.firstName;
          if (matched.lastName) createData.lastName = matched.lastName;
          if (matched.fullName) createData.fullName = matched.fullName;
          if (!createData.id && matched.id) createData.id = matched.id;
        }
      }

      // If only fullName is present, derive firstName/lastName so repository.save will persist them
      if (
        (createData.firstName === null || createData.firstName === undefined) &&
        (createData.lastName === null || createData.lastName === undefined) &&
        createData.fullName
      ) {
        const parts = String(createData.fullName).trim().split(/\s+/);
        if (parts.length === 1) {
          createData.firstName = parts[0];
          createData.lastName = null;
        } else {
          createData.firstName = parts.shift();
          createData.lastName = parts.join(' ');
        }
      }

      user = await UserRepository.create(
        createData,
        {
          ...this.options,
          transaction: tx,
        },
      );

      // Ensure email verification token is created and emailed for new users
      // NOTE: If we're sending invitation emails for these users, prefer
      // sending only the invitation (avoid duplicate email verification messages).
      try {
          if (!user.emailVerified && this.sendVerificationEmails) {
          const token = await UserRepository.generateEmailVerificationToken(
            user.email,
            {
              ...this.options,
              transaction: tx,
              bypassPermissionValidation: true,
            },
          );

          if (EmailSender.isConfigured) {
            const link = `${tenantSubdomain.frontendUrl(
              this.options.currentTenant,
            )}/auth/verify-email?token=${token}`;

            try {
              const vars: any = {
                link,
                tenant: this.options.currentTenant,
                guard: {
                  firstName: (this.data && this.data.firstName) || (user && user.firstName) || null,
                  lastName: (this.data && this.data.lastName) || (user && user.lastName) || null,
                  email: user && user.email,
                },
              };
              await new EmailSender(
                EmailSender.TEMPLATES.EMAIL_ADDRESS_VERIFICATION,
                vars,
              ).sendTo(user.email);
            } catch (err) {
              console.error('Failed to send email verification in UserCreator:', err);
            }
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error
          ? err.message
          : (typeof err === 'object' && err && 'message' in err ? (err as any).message : String(err));
        console.warn('Could not generate/send email verification token in UserCreator:', errorMessage);
      }
    }

    else {
      // If user already exists, ensure profile fields are updated when provided
      const profileUpdate: any = {};
      if (this.data.firstName) profileUpdate.firstName = this.data.firstName;
      else if (this.data.nombre) profileUpdate.firstName = this.data.nombre;

      if (this.data.lastName) profileUpdate.lastName = this.data.lastName;
      else if (this.data.apellido) profileUpdate.lastName = this.data.apellido;

      if (this.data.fullName) profileUpdate.fullName = this.data.fullName;
      else if (!profileUpdate.fullName && (profileUpdate.firstName || profileUpdate.lastName)) {
        profileUpdate.fullName = [profileUpdate.firstName, profileUpdate.lastName].filter(Boolean).join(' ').trim();
      }
      if (this.data.phoneNumber) profileUpdate.phoneNumber = this.data.phoneNumber;

      const hasProfileUpdates = Object.keys(profileUpdate).length > 0;
      if (hasProfileUpdates) {
        try {
          await UserRepository.updateProfile(user.id, profileUpdate, {
            ...this.options,
            transaction: tx,
            bypassPermissionValidation: true,
          });
        } catch (e) {
          const errorMessage = e instanceof Error
            ? e.message
            : (typeof e === 'object' && e && 'message' in e ? (e as any).message : String(e));
          console.warn('Failed to update existing user profile in UserCreator:', errorMessage);
        }
      }
    }

    const isUserAlreadyInTenant = (user.tenants || []).some(
      (userTenant) =>
        userTenant.tenant.id ===
        this.options.currentTenant.id,
    );

    // Determine optional assigned clients/post sites for this user (either top-level or per-email object)
    let clientIds = this.data.clientIds;
    let postSiteIds = this.data.postSiteIds;
    let securityGuardId = this.data.securityGuardId;
    if (Array.isArray(this.data.emails)) {
      const matched = this.data.emails.find((e) => {
        if (!e) return false;
        if (typeof e === 'string') return false;
        return (e.email === email) || (e.value === email);
      });
      if (matched && typeof matched === 'object') {
        if (matched.clientIds) clientIds = matched.clientIds;
        if (matched.postSiteIds) postSiteIds = matched.postSiteIds;
        if (matched.securityGuardId) securityGuardId = matched.securityGuardId;
      }
    }

    let tenantUser = await TenantUserRepository.updateRoles(
      this.options.currentTenant.id,
      user.id,
      this._roles,
      {
        ...this.options,
        addRoles: true,
        transaction: tx,
        // When creating invites, ensure the tenantUser remains in 'pending'
        // status until the invited user completes the registration form.
        forcePendingStatus: true,
      },
      clientIds,
      postSiteIds,
      securityGuardId, // Pass securityGuardId if provided
    );

    // Ensure invited users always have an invitation token when an invitation email
    // will be sent. This is important for customer invites, where `status` may be
    // active and the token is not generated automatically in updateRoles.
    if (!tenantUser.invitationToken) {
      try {
        tenantUser.invitationToken = crypto.randomBytes(20).toString('hex');
        tenantUser.invitationTokenExpiresAt = new Date(Date.now() + (60 * 60 * 1000));
        await tenantUser.save({ transaction: tx });
      } catch (err) {
        console.warn('userCreator: failed to generate invitation token for tenantUser', err && (err as any).message ? (err as any).message : err);
      }
    }

    if (!isUserAlreadyInTenant) {
      this.emailsToInvite.push({
        email,
        token: tenantUser.invitationToken,
      });
    }
  }

  /**
   * Verify if there are emails to invite.
   */
  get _hasEmailsToInvite() {
    return (
      this.emailsToInvite && this.emailsToInvite.length
    );
  }

  /**
   * Sends all invitation emails.
   */
  async _sendAllInvitationEmails() {
    if (!this.sendInvitationEmails) {
      return;
    }
    const results: any[] = [];

    for (const emailToInvite of this.emailsToInvite) {
      // Detect if el usuario es cliente (rol customer)
      const isCustomer = (Array.isArray(this.data.roles) && this.data.roles.includes(Roles.values.customer)) || this.data.role === Roles.values.customer;
      // Detect if el usuario es supervisor o staff administrativo (no guardia)
      const isSecurityGuard = (Array.isArray(this.data.roles) && this.data.roles.includes(Roles.values.securityGuard)) || this.data.role === Roles.values.securityGuard;
      const isStaffNonGuard = !isCustomer && !isSecurityGuard; // supervisor, admin, etc.
      
      // Determinar el path y tipo de invitación
      let invitationPath = '/auth/invitation';
      let inviteType = 'guard';
      
      if (isCustomer) {
        invitationPath = '/client/registration';
        inviteType = 'client';
      } else if (isStaffNonGuard) {
        // Supervisores y otros roles de staff usan el mismo flujo simplificado que clientes
        invitationPath = '/client/registration';
        inviteType = 'staff';
      }
      
      if (!emailToInvite.token) {
        console.warn('userCreator: skipping invitation email because no token was generated', { email: emailToInvite.email, inviteType });
        results.push({ error: 'Missing invitation token' });
        continue;
      }
      const link = `${tenantSubdomain.frontendUrl(
        this.options.currentTenant,
      )}${invitationPath}?token=${encodeURIComponent(emailToInvite.token)}&inviteType=${inviteType}`;

      // Log the invitation for debugging (non-production)
      try {
        if (process.env.NODE_ENV !== 'production') {
          console.info('Sending invitation to:', emailToInvite.email, 'link:', link);
        }
      } catch (e) {
        // ignore logging errors
      }

      try {
        // Detect if the user is cliente (rol customer), supervisor, or guard
        const isCustomer = (Array.isArray(this.data.roles) && this.data.roles.includes(Roles.values.customer)) || this.data.role === Roles.values.customer;
        const isSecurityGuard = (Array.isArray(this.data.roles) && this.data.roles.includes(Roles.values.securityGuard)) || this.data.role === Roles.values.securityGuard;
        const isStaffNonGuard = !isCustomer && !isSecurityGuard;
        
        const templateVars = {
          tenant: this.options.currentTenant,
          link,
          invitationLink: link,
          inviteLink: link,
          registrationLink: link,
          invitation: true,
          firstName: this.data.firstName || this.data.nombre || undefined,
          lastName: this.data.lastName || this.data.apellido || undefined,
          email: emailToInvite.email,
          // Use client template for customers and staff (supervisors, admins, etc.)
          ...(isCustomer || isStaffNonGuard ? { type: 'client-invitation' } : {}),
        };
        const sender = new EmailSender(
          EmailSender.TEMPLATES.INVITATION,
          templateVars,
        );
        const r = await sender.sendTo(emailToInvite.email);
        results.push(r);
      } catch (err) {
        // Log error but do not throw to avoid breaking other invites
        console.error('Failed to send invitation to', emailToInvite.email, err);
        results.push({ error: String(err) });
      }
    }

    return results;
  }

  /**
   * Validates the user(s) data.
   */
  async _validate() {
    assert(
      this.options.currentUser,
      'currentUser is required',
    );

    assert(
      this.options.currentTenant.id,
      'tenantId is required',
    );

    assert(
      this.options.currentUser.id,
      'currentUser.id is required',
    );

    assert(
      this.options.currentUser.email,
      'currentUser.email is required',
    );

    assert(
      this._emails && this._emails.length,
      'emails is required',
    );

    assert(
      this._roles && this._roles.length,
      'roles is required',
    );
  }
}
