import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import CustomerIdentityService from '../../services/customerIdentityService';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';

/**
 * POST /tenant/:tenantId/client-account/:id/send-portal-invitation
 *
 * Sends (or re-sends) a client portal invitation. Delegates all identity
 * provisioning (find/create user, find/create tenantUser, token, email) to
 * CustomerIdentityService which commits DB changes before sending the email.
 *
 * Works even when clientAccount.userId is null — the service creates the
 * user account automatically from the client's email address.
 *
 * Body (optional):
 *   { email: string }  — override recipient address
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const currentTenant = SequelizeRepository.getCurrentTenant(req);

    const clientAccount = await req.database.clientAccount.findOne({
      where: { id: req.params.id, tenantId: currentTenant.id },
    });

    if (!clientAccount) {
      throw new Error404();
    }

    // Build a plain data object, honouring optional email override from request body
    const raw = clientAccount.get({ plain: true });
    const clientData = (req.body && req.body.email)
      ? { ...raw, email: req.body.email }
      : raw;

    if (!clientData.email) {
      throw new Error400(req.language, 'user.errors.noEmail');
    }

    const result = await new CustomerIdentityService(req).provisionAndInvite(clientData);

    await ApiResponseHandler.success(req, res, { ...result, onboardingStatus: 'invited' });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
