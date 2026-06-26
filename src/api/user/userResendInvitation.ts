import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import { tenantSubdomain } from '../../services/tenantSubdomain';
import EmailSender from '../../services/emailSender';
import crypto from 'crypto';
import Roles from '../../security/roles';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.userEdit,
    );

    const transaction = SequelizeRepository.getTransaction(req);

    const tenantId = req.params.tenantId;
    const userId = req.params.id;

    let tenantUser = await TenantUserRepository.findByTenantAndUser(
      tenantId,
      userId,
      req,
    );

    if (!tenantUser) {
      throw new Error('TenantUser not found');
    }

    if (tenantUser.status !== 'invited' && tenantUser.status !== 'pending') {
      throw new Error('User has already accepted the invitation');
    }

    if (!tenantUser.invitationToken) {
      tenantUser.invitationToken = crypto.randomBytes(20).toString('hex');
      tenantUser.invitationTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await tenantUser.save({ transaction });
    }

    const roles = Array.isArray((tenantUser as any).roles) ? (tenantUser as any).roles : [];
    const isGuardInvite = roles.includes(Roles.values.securityGuard);
    const isCustomerInvite = roles.includes(Roles.values.customer);
    // Guards → guard app onboarding; customers → Mi Seguridad client view;
    // everyone else (admin/supervisor/dispatcher/office staff) → CRM panel onboarding.
    let invitationPath = '/auth/accept-invitation';
    let inviteType = 'staff';
    if (isGuardInvite) { invitationPath = '/auth/invitation'; inviteType = 'guard'; }
    else if (isCustomerInvite) { invitationPath = '/client/registration'; inviteType = 'client'; }
    if (!tenantUser.invitationToken) {
      tenantUser.invitationToken = crypto.randomBytes(20).toString('hex');
      tenantUser.invitationTokenExpiresAt = new Date(Date.now() + (60 * 60 * 1000));
      await tenantUser.save({ transaction });
    }
    const link = `${tenantSubdomain.frontendUrl(req.currentTenant)}${invitationPath}?token=${encodeURIComponent(tenantUser.invitationToken)}&inviteType=${inviteType}`;

    try {
      const sender = new EmailSender(EmailSender.TEMPLATES.INVITATION, {
        tenant: req.currentTenant,
        link,
        invitationLink: link,
        inviteLink: link,
        registrationLink: link,
        invitation: true,
      });

      // Always send to the invited user's OWN email. Never honor a client-supplied
      // recipient (req.body.email/to) — that would redirect a valid invitation
      // token to an attacker mailbox, an account-takeover primitive.
      const recipient = tenantUser && tenantUser.user && tenantUser.user.email;
      if (!recipient) {
        const err: any = new Error('No recipient email for invitation');
        err.code = 400;
        throw err;
      }

      await sender.sendTo(recipient);
    } catch (e) {
      console.error('Failed to resend invitation email:', e);
      throw e;
    }

    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
