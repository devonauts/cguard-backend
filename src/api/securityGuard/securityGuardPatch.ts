import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import Error400 from '../../errors/Error400';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardEdit,
    );

    const id = req.params.id;
    const incoming = req.body && req.body.data ? req.body.data : req.body;

    // Basic validations kept similar to the PUT handler
    if (incoming) {
      if (incoming.governmentId && incoming.governmentId.length > 50) {
        throw new Error400(req.language, 'entities.securityGuard.errors.validation.governmentIdTooLong');
      }
      if (incoming.guardCredentials && incoming.guardCredentials.length > 255) {
        throw new Error400(req.language, 'entities.securityGuard.errors.validation.guardCredentialsTooLong');
      }
      if (incoming.birthDate) {
        const moment = require('moment');
        const bd = moment(incoming.birthDate);
        if (!bd.isValid() || moment().diff(bd, 'years') < 18) {
          throw new Error400(req.language, 'entities.securityGuard.errors.validation.mustBeAdult');
        }
      }
    }

    const payload = await new SecurityGuardService(req).patchUpdate(id, incoming || {});

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
