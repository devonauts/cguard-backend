import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SequelizeRepository from '../../database/repositories/sequelizeRepository';
import CustomerIdentityService from '../../services/customerIdentityService';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import { isEmailEnabled } from '../../lib/emailPrefs';

/**
 * POST /tenant/:tenantId/client-account/:id/send-app-invitation
 *
 * "Invitar a la app" quick action — sends the Mi Seguridad app-download
 * invitation (separate from the welcome email). Honours the tenant's
 * "Invitación a la app Mi Seguridad" email preference.
 *
 * Body (optional): { email: string } — override recipient address
 */
export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.userEdit);

    const currentTenant = SequelizeRepository.getCurrentTenant(req);

    const appInviteEnabled = await isEmailEnabled(req.database, currentTenant.id, 'appInvite');
    if (!appInviteEnabled) {
      throw new Error400(req.language, 'La invitación a la app está desactivada en Preferencias de correo.');
    }

    const clientAccount = await req.database.clientAccount.findOne({
      where: { id: req.params.id, tenantId: currentTenant.id },
    });
    if (!clientAccount) {
      throw new Error404();
    }

    const raw = clientAccount.get({ plain: true });
    const clientData = (req.body && req.body.email)
      ? { ...raw, email: req.body.email }
      : raw;

    if (!clientData.email) {
      throw new Error400(req.language, 'user.errors.noEmail');
    }

    const result = await new CustomerIdentityService(req).provisionAndInvite(clientData, { variant: 'app' });

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
