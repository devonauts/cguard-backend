/**
 * POST /tenant/:tenantId/alarm/case/:id/close
 * Body: { disposition }  (real|false|test|runaway|cancelled)
 *
 * Close an alarm case with a final disposition: status -> closed, stamp
 * closedAt and disposition. Writes an audit log row.
 * Tenant-scoped; requires businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);

    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const actorId = currentUser && currentUser.id;

    const body = req.body || {};
    const disposition = body.disposition || null;

    const alarmCase = await db.alarmCase.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!alarmCase) throw new Error404();

    const now = new Date();
    await alarmCase.update({
      status: 'closed',
      closedAt: alarmCase.closedAt || now,
      disposition,
      // If a case is closed without an explicit resolve, treat it as resolved too.
      resolvedAt: alarmCase.resolvedAt || now,
      updatedById: actorId || null,
    });

    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'close',
      detail: `Caso cerrado${disposition ? ` (disposición: ${disposition})` : ''}`,
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    const plain =
      typeof alarmCase.get === 'function'
        ? alarmCase.get({ plain: true })
        : alarmCase;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
