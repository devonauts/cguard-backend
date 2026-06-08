/**
 * POST /tenant/:tenantId/alarm/case/:id/step
 * Body: { stepIndex: number, done: boolean, note?: string }
 * Records action-plan step completion on the case (stepProgress JSON) + audit +
 * real-time emit. Tenant-scoped; businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import { emitAlarmEvent } from '../../services/alarm/realtime';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const actorId = (req as any).currentUser && (req as any).currentUser.id;
    const body = req.body && req.body.data ? req.body.data : req.body || {};
    const stepIndex = Number(body.stepIndex);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new Error400(req.language, 'alarm.stepIndexRequired');
    }

    const c = await db.alarmCase.findOne({ where: { id: req.params.id, tenantId } });
    if (!c) throw new Error404();

    const progress = { ...((c.stepProgress as any) || {}) };
    progress[String(stepIndex)] = {
      done: !!body.done,
      note: body.note || null,
      at: new Date().toISOString(),
      by: actorId || null,
    };
    await c.update({ stepProgress: progress, updatedById: actorId || null });

    await db.alarmAuditLog.create({
      alarmCaseId: c.id,
      action: 'step',
      detail: `Paso ${stepIndex + 1} ${body.done ? 'completado' : 'desmarcado'}${body.note ? `: ${body.note}` : ''}`,
      actorId: actorId || null,
      at: new Date(),
      tenantId,
    });

    await emitAlarmEvent(db, tenantId, { eventType: 'alarm.case.updated', title: 'Plan de acción actualizado', caseId: c.id });

    await ApiResponseHandler.success(req, res, progress);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
