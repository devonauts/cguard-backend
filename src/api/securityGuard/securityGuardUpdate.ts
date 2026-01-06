import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import SecurityGuardRepository from '../../database/repositories/securityGuardRepository';
import Error400 from '../../errors/Error400';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardEdit,
    );

    // The frontend may send either the securityGuard record id or the user `guard` id.
    // Try to update by the provided id first; if not found, try to resolve a
    // securityGuard record by `guardId` and update that record instead.
    let targetId = req.params.id;

    try {
      // Try finding by securityGuard id
      await SecurityGuardRepository.findById(targetId, req);
    } catch (err) {
      // If not found as a securityGuard id, try to find by guard (user) id
      try {
        const found = await SecurityGuardRepository.findAndCountAll(
          { filter: { guard: targetId }, limit: 1 },
          req,
        );
        if (found && found.count > 0) {
          targetId = found.rows[0].id;
        }
      } catch (err2) {
        // ignore and proceed — the service.update will surface the error
      }
    }

    // Validate lengths from payload before calling service
    const incoming = req.body && req.body.data ? req.body.data : req.body;
    if (incoming) {
      if (incoming.governmentId && incoming.governmentId.length > 50) {
        throw new Error400(req.language, 'entities.securityGuard.errors.validation.governmentIdTooLong');
      }
      if (incoming.guardCredentials && incoming.guardCredentials.length > 255) {
        throw new Error400(req.language, 'entities.securityGuard.errors.validation.guardCredentialsTooLong');
      }
      // Validate birthDate -> must be adult (>=18)
      if (incoming.birthDate) {
        // lazy import moment to avoid top-level import if not needed elsewhere
        const moment = require('moment');
        const bd = moment(incoming.birthDate);
        if (!bd.isValid() || moment().diff(bd, 'years') < 18) {
          throw new Error400(req.language, 'entities.securityGuard.errors.validation.mustBeAdult');
        }
      }
    }

    const payload = await new SecurityGuardService(req).update(
      targetId,
      incoming || req.body.data || req.body,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
