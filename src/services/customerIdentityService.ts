import crypto from 'crypto';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import { invitationTokenExpiry } from './auth/invitationToken';
import UserRepository from '../database/repositories/userRepository';
import { tenantSubdomain } from './tenantSubdomain';
import EmailSender from './emailSender';
import Roles from '../security/roles';
import Error400 from '../errors/Error400';
import { syncIdentityFromUser } from './identitySync';

export type CustomerOnboardingStatus = 'not_invited' | 'invited' | 'active' | 'suspended';

const uuid = () =>
  (crypto as any).randomUUID ? (crypto as any).randomUUID() : crypto.randomBytes(16).toString('hex');

/**
 * Single-responsibility service for managing customer digital identity (app access).
 *
 *  - provisionAndInvite        → the PRIMARY contact (representante legal / titular).
 *                                Links via clientAccount.userId + syncs identity.
 *  - provisionAdditionalAccess → EXTRA people who also want app access (persona
 *                                encargada, a family member…). Links via the
 *                                tenant_user_client_accounts pivot (so multiple
 *                                users map to one client — see authSignInCustomer).
 *
 * Both reuse the same internal steps (find/create user → ensure `customer`
 * tenantUser → fresh invite token → email after commit). All idempotent.
 */
export default class CustomerIdentityService {
  options: any;

  constructor(options: any) {
    this.options = options;
  }

  /**
   * Find/create the auth user, ensure a tenantUser with the `customer` role, and
   * stamp a fresh 24h invitation token. Shared by both provisioning paths.
   * Runs inside the caller's transaction.
   */
  private async _provisionCustomerUser(
    transaction: any,
    identity: { email: string; firstName?: string; lastName?: string; phone?: string | null },
  ): Promise<{ userId: string; tenantUser: any; invitationToken: string }> {
    const { database, currentTenant } = this.options;

    let user = await UserRepository.findByEmailWithoutAvatar(identity.email, {
      ...this.options,
      transaction,
      bypassPermissionValidation: true,
    });
    if (!user) {
      user = await database.user.create(
        {
          email: identity.email,
          firstName: identity.firstName || '',
          lastName: identity.lastName || '',
          phoneNumber: identity.phone || null,
        },
        { transaction },
      );
    }
    const userId = user.id;

    // Ensure tenantUser with the customer role.
    let tenantUser = await TenantUserRepository.findByTenantAndUser(currentTenant.id, userId, { ...this.options, transaction });
    if (!tenantUser) {
      await TenantUserRepository.updateRoles(currentTenant.id, userId, [Roles.values.customer], { ...this.options, transaction, forcePendingStatus: true });
      tenantUser = await TenantUserRepository.findByTenantAndUser(currentTenant.id, userId, { ...this.options, transaction });
    } else {
      const existingRoles: string[] = Array.isArray((tenantUser as any).roles) ? (tenantUser as any).roles : [];
      if (!existingRoles.includes(Roles.values.customer)) {
        await TenantUserRepository.updateRoles(currentTenant.id, userId, [...existingRoles, Roles.values.customer], { ...this.options, transaction });
        tenantUser = await TenantUserRepository.findByTenantAndUser(currentTenant.id, userId, { ...this.options, transaction });
      }
    }
    if (!tenantUser) throw new Error('CustomerIdentityService: could not find or create tenantUser');

    const invitationToken = crypto.randomBytes(20).toString('hex');
    (tenantUser as any).invitationToken = invitationToken;
    (tenantUser as any).invitationTokenExpiresAt = invitationTokenExpiry();
    (tenantUser as any).status = 'invited';
    await (tenantUser as any).save({ transaction });

    return { userId, tenantUser, invitationToken };
  }

  /** Build the registration link + send the invitation email (after commit; never blocks). */
  private async _sendClientInvite(recipientEmail: string, firstName: string, invitationToken: string, variant: 'welcome' | 'app') {
    const { database, currentTenant } = this.options;
    const link = `${tenantSubdomain.frontendUrl(currentTenant)}/client/registration?token=${encodeURIComponent(invitationToken)}&inviteType=client`;

    let tenantLogoUrl: string | null = null;
    try {
      const tenantSettings = await database.settings.findOne({ where: { tenantId: currentTenant.id } });
      tenantLogoUrl = (tenantSettings && tenantSettings.logoUrl) || null;
    } catch (settingsErr) {
      console.warn('CustomerIdentityService: could not load tenant settings for logo', settingsErr);
    }

    const tenantWithLogo = { ...((currentTenant.get ? currentTenant.get({ plain: true }) : currentTenant)), logoUrl: tenantLogoUrl };
    const baseVars: any = { tenant: tenantWithLogo, link, invitationLink: link, inviteLink: link, registrationLink: link, firstName: firstName || '', lastName: '' };
    const vars = variant === 'app' ? { ...baseVars, appInvite: true } : { ...baseVars, invitation: true, clientInvitation: true };

    new EmailSender(EmailSender.TEMPLATES.INVITATION, vars)
      .sendTo(recipientEmail)
      .catch((emailErr: any) =>
        console.error('[CustomerIdentityService] invitation email send failed (non-blocking):', emailErr && emailErr.message ? emailErr.message : emailErr),
      );
  }

  /**
   * PRIMARY contact (representante legal / titular): provision + link via
   * clientAccount.userId + reconcile the identity cache + invite.
   * @param clientAccount  Plain object with id, email, name, lastName, phoneNumber, tenantId
   */
  async provisionAndInvite(
    clientAccount: any,
    opts: { variant?: 'welcome' | 'app' } = {},
  ): Promise<{ sent: boolean; recipient: string }> {
    const { database, currentTenant, language } = this.options;
    const variant = opts.variant === 'app' ? 'app' : 'welcome';

    const recipientEmail = (clientAccount.email || '').toString().trim().toLowerCase();
    if (!recipientEmail) {
      throw new Error400(language, 'user.errors.noEmail');
    }

    const transaction = await SequelizeRepository.createTransaction(database);
    try {
      const { userId, invitationToken } = await this._provisionCustomerUser(transaction, {
        email: recipientEmail,
        firstName: clientAccount.name || '',
        lastName: clientAccount.lastName || '',
        phone: (clientAccount as any).phoneNumber || null,
      });

      // Link userId to clientAccount if not already set.
      if (!clientAccount.userId || String(clientAccount.userId) !== String(userId)) {
        await database.clientAccount.update({ userId }, { where: { id: clientAccount.id }, transaction });
      }

      // The user is the single source of identity — reconcile the clientAccount cache.
      await syncIdentityFromUser(database, userId, { ...this.options, currentTenant, transaction });

      if (variant === 'welcome') {
        await database.clientAccount.update({ onboardingStatus: 'invited' }, { where: { id: clientAccount.id }, transaction });
      }

      await SequelizeRepository.commitTransaction(transaction);
      await this._sendClientInvite(recipientEmail, (clientAccount as any).name || '', invitationToken, variant);
      return { sent: true, recipient: recipientEmail };
    } catch (err) {
      try { await SequelizeRepository.rollbackTransaction(transaction); } catch (rbErr) {
        console.error('CustomerIdentityService.provisionAndInvite: rollback failed', rbErr);
      }
      throw err;
    }
  }

  /**
   * ADDITIONAL access person (persona encargada / family member): provision +
   * link to the SAME clientAccount via the tenant_user_client_accounts pivot +
   * invite. Does NOT touch clientAccount.userId (that's the primary). Idempotent.
   * No-op when the contact has no email.
   */
  async provisionAdditionalAccess(
    clientAccount: any,
    contact: { name?: string; email?: string; phone?: string | null },
  ): Promise<{ sent: boolean; recipient: string }> {
    const { database } = this.options;
    const recipientEmail = (contact.email || '').toString().trim().toLowerCase();
    if (!recipientEmail) return { sent: false, recipient: '' };

    const parts = (contact.name || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ');

    const transaction = await SequelizeRepository.createTransaction(database);
    try {
      const { tenantUser, invitationToken } = await this._provisionCustomerUser(transaction, {
        email: recipientEmail, firstName, lastName, phone: contact.phone || null,
      });

      // Link this user to the client via the pivot (idempotent).
      const [existing] = await database.sequelize.query(
        'SELECT id FROM tenant_user_client_accounts WHERE tenantUserId = ? AND clientAccountId = ? LIMIT 1',
        { replacements: [tenantUser.id, clientAccount.id], transaction },
      );
      if (!existing || !existing.length) {
        const now = new Date();
        await database.sequelize.getQueryInterface().bulkInsert(
          'tenant_user_client_accounts',
          [{ id: uuid(), tenantUserId: tenantUser.id, clientAccountId: clientAccount.id, createdAt: now, updatedAt: now }],
          { transaction },
        );
      }

      await SequelizeRepository.commitTransaction(transaction);
      await this._sendClientInvite(recipientEmail, firstName, invitationToken, 'welcome');
      return { sent: true, recipient: recipientEmail };
    } catch (err) {
      try { await SequelizeRepository.rollbackTransaction(transaction); } catch (rbErr) {
        console.error('CustomerIdentityService.provisionAdditionalAccess: rollback failed', rbErr);
      }
      throw err;
    }
  }

  /**
   * Marks the customer's onboardingStatus as active.
   * Called after the customer completes registration (accepts invitation).
   */
  static async markActive(userId: string, tenantId: string, database: any): Promise<void> {
    try {
      await database.clientAccount.update({ onboardingStatus: 'active' }, { where: { userId, tenantId } });
    } catch (err) {
      console.warn('CustomerIdentityService.markActive: could not update onboardingStatus', err && (err as any).message ? (err as any).message : err);
    }
  }
}
