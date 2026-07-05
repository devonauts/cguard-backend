import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import MemosService from '../../services/memosService';
import { memoRecipientScope } from './memoScope';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.memosAutocomplete,
    );

    // Autocomplete is a CRM picker; a guard recipient gets nothing.
    if (await memoRecipientScope(req)) {
      await ApiResponseHandler.success(req, res, []);
      return;
    }

    const payload = await new MemosService(
      req,
    ).findAllAutocomplete(req.query.query, req.query.limit);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
