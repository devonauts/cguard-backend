import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import UserRepository from '../../database/repositories/userRepository';

export default async (req, res, next) => {
  try {
    const token = req.query && (req.query.token || req.query.invitationToken || req.query.invite);
    if (!token) {
      throw new Error('Invalid invitation token');
    }

    const tenantUser = await TenantUserRepository.findByInvitationToken(token, req);
    if (!tenantUser) {
      throw new Error('Invalid invitation token');
    }

    const user = await UserRepository.findById(tenantUser.userId, {
      ...req,
      bypassPermissionValidation: true,
    });

    if (!user) {
      throw new Error('Invalid invitation token');
    }

    if (token && !user.emailVerified) {
      try {
        await UserRepository.markEmailVerified(user.id, {
          ...req,
          bypassPermissionValidation: true,
        });
      } catch (markErr) {
        console.warn('Failed to mark invited user email verified:', markErr && (markErr as any).message ? (markErr as any).message : markErr);
      }
    }

    const payload: any = {
      invitationToken: tenantUser.invitationToken || null,
      tenantUserStatus: tenantUser.status || null,
      email: user.email || null,
      firstName: user.firstName || null,
      lastName: user.lastName || null,
      fullName:
        user.fullName ||
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        null,
    };

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};