import assert from 'assert';
import EmailSender from '../../services/emailSender';
import UserRepository from '../../database/repositories/userRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import { tenantSubdomain } from '../tenantSubdomain';
import { IServiceOptions } from '../IServiceOptions';
export default class UserCreator {
  options: IServiceOptions;
  transaction;
  data;
  emailsToInvite: Array<any> = [];
  emails: any = [];
  sendInvitationEmails = true;

  constructor(options) {
    this.options = options;
  }

  /**
   * Creates new user(s) via the User page.
   * Sends Invitation Emails if flagged.
   */
  async execute(data, sendInvitationEmails = true) {
    this.data = data;
    this.sendInvitationEmails = sendInvitationEmails;

    await this._validate();

    try {
      this.transaction = await SequelizeRepository.createTransaction(
        this.options.database,
      );

      await this._addOrUpdateAll();

      await SequelizeRepository.commitTransaction(
        this.transaction,
      );
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(
        this.transaction,
      );
      throw error;
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
    return Promise.all(
      this.emails.map((email) => this._addOrUpdate(email)),
    );
  }

  /**
   * Creates or updates the user passed.
   * If the user already exists, it only adds the role to the user.
   */
  async _addOrUpdate(email) {
    let user = await UserRepository.findByEmailWithoutAvatar(
      email,
      {
        ...this.options,
        transaction: this.transaction,
      },
    );

    if (!user) {
      const createData: any = { email };

      // If names are provided at top-level, prefer them
      if (this.data.firstName) {
        createData.firstName = this.data.firstName;
      }
      if (this.data.lastName) {
        createData.lastName = this.data.lastName;
      }
      if (this.data.fullName) {
        createData.fullName = this.data.fullName;
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
          transaction: this.transaction,
        },
      );

      // Ensure email verification token is created and emailed for new users
      try {
        if (!user.emailVerified) {
          const token = await UserRepository.generateEmailVerificationToken(
            user.email,
            {
              ...this.options,
              transaction: this.transaction,
              bypassPermissionValidation: true,
            },
          );

          if (EmailSender.isConfigured) {
            const link = `${tenantSubdomain.frontendUrl(
              this.options.currentTenant,
            )}/auth/verify-email?token=${token}`;

            try {
              await new EmailSender(
                EmailSender.TEMPLATES.EMAIL_ADDRESS_VERIFICATION,
                { link },
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
      if (this.data.lastName) profileUpdate.lastName = this.data.lastName;
      if (this.data.fullName) profileUpdate.fullName = this.data.fullName;
      if (this.data.phoneNumber) profileUpdate.phoneNumber = this.data.phoneNumber;

      const hasProfileUpdates = Object.keys(profileUpdate).length > 0;
      if (hasProfileUpdates) {
        try {
          await UserRepository.updateProfile(user.id, profileUpdate, {
            ...this.options,
            transaction: this.transaction,
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

    const tenantUser = await TenantUserRepository.updateRoles(
      this.options.currentTenant.id,
      user.id,
      this._roles,
      {
        ...this.options,
        addRoles: true,
        transaction: this.transaction,
      },
      clientIds,
      postSiteIds,
      securityGuardId, // Pass securityGuardId if provided
    );

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
      const link = `${tenantSubdomain.frontendUrl(
        this.options.currentTenant,
      )}/auth/invitation?token=${emailToInvite.token}`;

      // Log the invitation for debugging (non-production)
      try {
        if (process.env.NODE_ENV !== 'production') {
          console.info('Sending invitation to:', emailToInvite.email, 'link:', link);
        }
      } catch (e) {
        // ignore logging errors
      }

      try {
        const sender = new EmailSender(
          EmailSender.TEMPLATES.INVITATION,
          {
            tenant: this.options.currentTenant,
            link,
          },
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
