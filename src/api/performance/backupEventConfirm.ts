/**
 * POST /api/tenant/:tenantId/backup-event/:id/confirm
 * POST /api/tenant/:tenantId/backup-event/:id/reject
 * A supervisor confirms a backup event resulted in actual coverage (awards
 * cover points), or rejects it (no points). The action is taken from the path.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import BackupService from '../../services/backupService';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.backupConfirm);
    const db = req.database;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const reject = /reject/i.test(req.path);

    const result = reject
      ? await BackupService.reject(db, {
          tenantId,
          eventId: req.params.id,
          confirmedById: req.currentUser.id,
        })
      : await BackupService.confirmCover(db, {
          tenantId,
          eventId: req.params.id,
          confirmedById: req.currentUser.id,
        });

    if (!result) throw new Error400(req.language, 'backup.eventNotFound');
    return ApiResponseHandler.success(req, res, result);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
