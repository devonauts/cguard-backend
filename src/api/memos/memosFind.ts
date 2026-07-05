import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import MemosService from '../../services/memosService';
import Error403 from '../../errors/Error403';
import { memoRecipientScope } from './memoScope';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.memosRead,
    );

    const payload = await new MemosService(req).findById(
      req.params.id,
    );

    // Isolation: a guard recipient may only read a memo addressed to them.
    const scope = await memoRecipientScope(req);
    if (scope && payload && String(payload.guardNameId) !== scope) {
      throw new Error403(req.language);
    }

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
