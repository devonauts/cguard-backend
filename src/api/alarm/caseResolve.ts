/**
 * POST /tenant/:tenantId/alarm/case/:id/resolve
 *
 * Mark an alarm case as resolved (handled, awaiting close): status -> resolved,
 * stamp resolvedAt. Writes an audit log row.
 * Tenant-scoped; requires businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import { emitAlarmEvent } from '../../services/alarm/realtime';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);

    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const actorId = currentUser && currentUser.id;

    const alarmCase = await db.alarmCase.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!alarmCase) throw new Error404();

    const now = new Date();
    await alarmCase.update({
      status: 'resolved',
      resolvedAt: alarmCase.resolvedAt || now,
      updatedById: actorId || null,
    });

    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'resolve',
      detail: (req.body && req.body.note) || 'Caso resuelto',
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    await emitAlarmEvent(db, tenantId, { eventType: 'alarm.case.updated', title: 'Caso resuelto', caseId: alarmCase.id, payload: { status: 'resolved' } });

    const plain =
      typeof alarmCase.get === 'function'
        ? alarmCase.get({ plain: true })
        : alarmCase;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
