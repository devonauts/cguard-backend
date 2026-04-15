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

    if (tenantUser.status !== 'invited') {
      throw new Error('Only invited users can receive invitations');
    }

    if (!tenantUser.invitationToken) {
      tenantUser.invitationToken = crypto.randomBytes(20).toString('hex');
      await tenantUser.save({ transaction });
    }

    const roles = Array.isArray((tenantUser as any).roles) ? (tenantUser as any).roles : [];
    const isGuardInvite = roles.includes(Roles.values.securityGuard);
    const invitationPath = isGuardInvite ? '/auth/invitation' : '/client/registration';
    const inviteType = isGuardInvite ? 'guard' : 'client';
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

      const recipient = req.body.email || req.body.to || (tenantUser && tenantUser.user && tenantUser.user.email);
      if (!recipient) {
        throw new Error('No recipient email for invitation');
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
