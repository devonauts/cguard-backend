/**
 * POST /tenant/:tenantId/alarm/case/:id/acknowledge
 *
 * An operator takes ownership of a queued case: status -> acknowledged, stamp
 * ackAt and assign the operator. Writes an audit log row.
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

    // The operator's recorded action (what they did to handle the SOS) — stored in
    // history so silencing an alarm always has an accountable, audited reason.
    const body = (req as any).body?.data || (req as any).body || {};
    const action = String(body.action || body.note || '').trim().slice(0, 1000);

    const now = new Date();
    await alarmCase.update({
      status: 'acknowledged',
      ackAt: alarmCase.ackAt || now,
      assignedOperatorId: actorId || alarmCase.assignedOperatorId || null,
      updatedById: actorId || null,
    });

    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'acknowledge',
      detail: action
        ? `Reconocido y silenciado. Acción tomada: ${action}`
        : 'Caso reconocido por el operador',
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    await emitAlarmEvent(db, tenantId, { eventType: 'alarm.case.updated', title: 'Caso reconocido', caseId: alarmCase.id, payload: { status: 'acknowledged', assignedOperatorId: actorId } });

    const plain =
      typeof alarmCase.get === 'function'
        ? alarmCase.get({ plain: true })
        : alarmCase;
    await ApiResponseHandler.success(req, res, plain);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
