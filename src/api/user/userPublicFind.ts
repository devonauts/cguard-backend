import ApiResponseHandler from '../apiResponseHandler';
import TenantUserRepository from '../../database/repositories/tenantUserRepository';
import UserRepository from '../../database/repositories/userRepository';

export default async (req, res, next) => {
  try {
    const token = req.query && (req.query.token || req.query.invitationToken || req.query.invite);
    if (!token) {
      const err = new Error('Token de invitación inválido o expirado');
      (err as any).code = 400;
      err.name = 'InvalidInvitationToken';
      return await ApiResponseHandler.error(req, res, err);
    }

    const tenantUser = await TenantUserRepository.findByInvitationToken(token, req);
    if (!tenantUser) {
      // Token invalid or expired - return a more specific error
      const err = new Error('Token de invitación inválido o expirado');
      err.name = 'InvalidInvitationToken';
      (err as any).code = 400;
      return await ApiResponseHandler.error(req, res, err);
    }

    const user = await UserRepository.findById(tenantUser.userId, {
      ...req,
      bypassPermissionValidation: true,
    });

    if (!user) {
      throw new Error('Invalid invitation token');
    }

    // IMPORTANT: Do NOT mark email as verified here during the GET request.
    // Marking email verified will invalidate the invitation token before
    // the user completes registration. Email verification should only happen
    // when the user submits their password (signup/POST).
    // The invitation token must remain valid until form submission.

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
      roles: tenantUser.roles || [],
    };

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};