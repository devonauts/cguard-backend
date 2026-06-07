import crypto from 'crypto';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import TenantUserRepository from '../database/repositories/tenantUserRepository';
import UserRepository from '../database/repositories/userRepository';
import { tenantSubdomain } from './tenantSubdomain';
import EmailSender from './emailSender';
import Roles from '../security/roles';
import Error400 from '../errors/Error400';
import { syncIdentityFromUser } from './identitySync';

export type CustomerOnboardingStatus = 'not_invited' | 'invited' | 'active' | 'suspended';

/**
 * Single-responsibility service for managing customer digital identity.
 *
 * Responsibilities:
 *  - Find or create the auth user record for a clientAccount email
 *  - Find or create the tenantUser with the customer role
 *  - Generate invitation tokens
 *  - Send invitation emails AFTER DB commit (prevents email-before-rollback)
 *  - Update clientAccount.onboardingStatus and clientAccount.userId atomically
 *
 * All methods are idempotent: calling them multiple times produces the same result.
 */
export default class CustomerIdentityService {
  options: any;

  constructor(options: any) {
    this.options = options;
  }

  /**
   * Ensures a user exists for the clientAccount email, links it, creates a
   * tenantUser with the customer role, generates a fresh 24h invitation
   * token, commits the DB changes, THEN sends the email.
   *
   * Safe to call whether or not clientAccount.userId is already set — it is
   * idempotent and always produces a valid invitation.
   *
   * @param clientAccount  Plain object (or Sequelize instance) with id, email, name, tenantId
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
      // ── Step 1: Resolve the user record ────────────────────────────────────
      let user = await UserRepository.findByEmailWithoutAvatar(recipientEmail, {
        ...this.options,
        transaction,
        bypassPermissionValidation: true,
      });

      if (!user) {
        // Seed the new authoritative user record FROM the clientAccount's
        // staged identity (including phoneNumber) so the subsequent
        // syncIdentityFromUser reconciliation does not blank values the admin
        // just entered. From here on, the user is the single source of truth.
        user = await database.user.create(
          {
            email: recipientEmail,
            firstName: clientAccount.name || '',
            lastName: clientAccount.lastName || '',
            phoneNumber: (clientAccount as any).phoneNumber || null,
          },
          { transaction },
        );
      }

      const userId = user.id;

      // ── Step 2: Link userId to clientAccount if not already set ─────────────
      if (!clientAccount.userId || String(clientAccount.userId) !== String(userId)) {
        await database.clientAccount.update(
          { userId },
          { where: { id: clientAccount.id }, transaction },
        );
      }

      // ── Step 2b: Reconcile the denormalized clientAccount identity cache ─────
      // The user is the single source of identity. After linking, sync the
      // clientAccount.name/lastName/email/phoneNumber cache FROM the user so the
      // two never drift. Best-effort; runs inside this transaction.
      await syncIdentityFromUser(database, userId, {
        ...this.options,
        currentTenant,
        transaction,
      });

      // ── Step 3: Ensure tenantUser with customer role ─────────────────────────
      let tenantUser = await TenantUserRepository.findByTenantAndUser(
        currentTenant.id,
        userId,
        { ...this.options, transaction },
      );

      if (!tenantUser) {
        await TenantUserRepository.updateRoles(
          currentTenant.id,
          userId,
          [Roles.values.customer],
          { ...this.options, transaction, forcePendingStatus: true },
        );
        tenantUser = await TenantUserRepository.findByTenantAndUser(
          currentTenant.id,
          userId,
          { ...this.options, transaction },
        );
      } else {
        const existingRoles: string[] = Array.isArray((tenantUser as any).roles)
          ? (tenantUser as any).roles
          : [];
        if (!existingRoles.includes(Roles.values.customer)) {
          await TenantUserRepository.updateRoles(
            currentTenant.id,
            userId,
            [...existingRoles, Roles.values.customer],
            { ...this.options, transaction },
          );
          tenantUser = await TenantUserRepository.findByTenantAndUser(
            currentTenant.id,
            userId,
            { ...this.options, transaction },
          );
        }
      }

      if (!tenantUser) {
        throw new Error('CustomerIdentityService: could not find or create tenantUser');
      }

      // ── Step 4: Generate a fresh 24h invitation token ────────────────────────
      const invitationToken = crypto.randomBytes(20).toString('hex');
      (tenantUser as any).invitationToken = invitationToken;
      (tenantUser as any).invitationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      (tenantUser as any).status = 'invited';
      await (tenantUser as any).save({ transaction });

      // ── Step 5: Update onboardingStatus on the clientAccount record ──────────
      // For the app-invite variant, do NOT downgrade an already-active client
      // back to "invited" — it's a re-engagement nudge, not initial onboarding.
      if (variant === 'welcome') {
        await database.clientAccount.update(
          { onboardingStatus: 'invited' },
          { where: { id: clientAccount.id }, transaction },
        );
      }

      // ── Step 6: Commit ALL DB changes before sending email ───────────────────
      await SequelizeRepository.commitTransaction(transaction);

      // ── Step 7: Send invitation email (after commit — safe to fail) ──────────
      const link = `${tenantSubdomain.frontendUrl(currentTenant)}/client/registration?token=${encodeURIComponent(invitationToken)}&inviteType=client`;

      // Fetch the tenant's settings to get their logo URL
      let tenantLogoUrl: string | null = null;
      try {
        const tenantSettings = await database.settings.findOne({ where: { tenantId: currentTenant.id } });
        tenantLogoUrl = (tenantSettings && tenantSettings.logoUrl) || null;
      } catch (settingsErr) {
        console.warn('CustomerIdentityService: could not load tenant settings for logo', settingsErr);
      }

      const tenantWithLogo = { ...((currentTenant.get ? currentTenant.get({ plain: true }) : currentTenant)), logoUrl: tenantLogoUrl };

      const baseVars: any = {
        tenant: tenantWithLogo,
        link,
        invitationLink: link,
        inviteLink: link,
        registrationLink: link,
        firstName: (clientAccount as any).name || '',
        lastName: '',
      };
      const vars = variant === 'app'
        ? { ...baseVars, appInvite: true }
        : { ...baseVars, invitation: true, clientInvitation: true };

      const sender = new EmailSender(EmailSender.TEMPLATES.INVITATION, vars);

      // Fire-and-forget: the SMTP send can be slow or time out (it must not block
      // the client save — the DB changes are already committed above). If delivery
      // fails, the admin can re-send via "Enviar acceso a la app".
      sender
        .sendTo(recipientEmail)
        .catch((emailErr: any) =>
          console.error(
            '[CustomerIdentityService] invitation email send failed (non-blocking):',
            emailErr && emailErr.message ? emailErr.message : emailErr,
          ),
        );

      return { sent: true, recipient: recipientEmail };
    } catch (err) {
      try {
        await SequelizeRepository.rollbackTransaction(transaction);
      } catch (rbErr) {
        console.error('CustomerIdentityService.provisionAndInvite: rollback failed', rbErr);
      }
      throw err;
    }
  }

  /**
   * Marks the customer's onboardingStatus as active.
   * Called after the customer completes registration (accepts invitation).
   * Non-throwing — logs warnings on failure.
   */
  static async markActive(userId: string, tenantId: string, database: any): Promise<void> {
    try {
      await database.clientAccount.update(
        { onboardingStatus: 'active' },
        { where: { userId, tenantId } },
      );
    } catch (err) {
      console.warn(
        'CustomerIdentityService.markActive: could not update onboardingStatus',
        err && (err as any).message ? (err as any).message : err,
      );
    }
  }
}
