import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import EmailSender from '../../services/emailSender';
import crypto from 'crypto';
import Roles from '../../security/roles';
import UserCreator from '../../services/user/userCreator';
import UserRepository from '../../database/repositories/userRepository';
import Error400 from '../../errors/Error400';

/**
 * POST /tenant/:tenantId/user/:id/send-portal-invitation
 *
 * Sends (or re-sends) a client portal invitation to the user linked to a
 * clientAccount.  Unlike /resend-invitation this works regardless of the
 * current tenantUser status so admins can trigger it any time.
 *
 * Body (optional):
 *   { email: string }  — override recipient address
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const transaction = await SequelizeRepository.createTransaction(req.database);

    try {
      const tenantId = req.params.tenantId;
      const userId = req.params.id;

      // Find or create user
      let user = await UserRepository.findById(userId, { ...req, transaction, bypassPermissionValidation: true });
      if (!user) {
        throw new Error400(req.language, 'user.errors.userNotFound');
      }

      // Find or create tenantUser with customer role
      let tenantUser = await TenantUserRepository.findByTenantAndUser(tenantId, userId, { ...req, transaction });

      if (!tenantUser) {
        // Create tenantUser with customer role and invited status
        await TenantUserRepository.updateRoles(
          tenantId,
          userId,
          [Roles.values.customer],
          { ...req, transaction, forcePendingStatus: true },
        );
        tenantUser = await TenantUserRepository.findByTenantAndUser(tenantId, userId, { ...req, transaction });
      }

      if (!tenantUser) {
        throw new Error('Could not create or find tenantUser for this user');
      }

      // Ensure the tenantUser has the customer role
      const existingRoles: string[] = Array.isArray((tenantUser as any).roles) ? (tenantUser as any).roles : [];
      if (!existingRoles.includes(Roles.values.customer)) {
        const updatedRoles = [...existingRoles, Roles.values.customer];
        await TenantUserRepository.updateRoles(
          tenantId,
          userId,
          updatedRoles,
          { ...req, transaction },
        );
        tenantUser = await TenantUserRepository.findByTenantAndUser(tenantId, userId, { ...req, transaction });
      }

      // Always generate a fresh invitation token
      (tenantUser as any).invitationToken = crypto.randomBytes(20).toString('hex');
      (tenantUser as any).invitationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
      (tenantUser as any).status = 'invited';
      await (tenantUser as any).save({ transaction });

      const link = `${tenantSubdomain.frontendUrl(req.currentTenant)}/client/registration?token=${encodeURIComponent((tenantUser as any).invitationToken)}&inviteType=client`;

      const recipient = (req.body && req.body.email) || user.email;
      if (!recipient) {
        throw new Error400(req.language, 'user.errors.noEmail');
      }

      const sender = new EmailSender(EmailSender.TEMPLATES.INVITATION, {
        tenant: req.currentTenant,
        link,
        invitationLink: link,
        inviteLink: link,
        registrationLink: link,
        invitation: true,
      });

      await sender.sendTo(recipient);

      await SequelizeRepository.commitTransaction(transaction);

      await ApiResponseHandler.success(req, res, { sent: true, recipient });
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
