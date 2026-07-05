import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import MemosService from '../../services/memosService';
import { memoRecipientScope } from './memoScope';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.memosRead,
    );

    // Isolation: a guard recipient may only list their OWN memos — force their
    // securityGuard id and ignore any client-supplied filter[guardName].
    const scope = await memoRecipientScope(req);
    const query: any = { ...req.query };
    if (scope) {
      query.filter = { ...(query.filter || {}), guardName: scope };
    }

    const payload = await new MemosService(req).findAndCountAll(query);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
