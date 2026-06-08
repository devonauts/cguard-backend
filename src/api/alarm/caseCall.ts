/**
 * POST /tenant/:tenantId/alarm/case/:id/call
 * Logs an Enhanced Call Verification (ECV) attempt and recomputes the case's ECV
 * state. ECV is satisfied after >=2 attempts OR any 'verified_real' outcome.
 * Body: { alarmContactId?, contactName?, phone?, outcome, note? }
 * Tenant-scoped; businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';
import { emitAlarmEvent } from '../../services/alarm/realtime';

const OUTCOMES = ['contacted', 'no_answer', 'verified_real', 'verified_false', 'cancel_passcode'];

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const actorId = (req as any).currentUser && (req as any).currentUser.id;
    const body = req.body && req.body.data ? req.body.data : req.body || {};
    const outcome = String(body.outcome || '');
    if (!OUTCOMES.includes(outcome)) throw new Error400(req.language, 'alarm.callOutcomeRequired');

    const alarmCase = await db.alarmCase.findOne({ where: { id: req.params.id, tenantId } });
    if (!alarmCase) throw new Error404();

    const now = new Date();
    const call = await db.alarmCallLog.create({
      alarmCaseId: alarmCase.id,
      alarmContactId: body.alarmContactId || null,
      contactName: body.contactName || null,
      phone: body.phone || null,
      outcome,
      note: body.note || null,
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    // Recompute ECV: >=2 attempts, or any verified-real.
    const calls = await db.alarmCallLog.findAll({ where: { alarmCaseId: alarmCase.id, tenantId } });
    const attempts = (calls || []).length;
    const anyVerifiedReal = (calls || []).some((c: any) => c.outcome === 'verified_real');
    const ecvSatisfied = attempts >= 2 || anyVerifiedReal;
    if (ecvSatisfied !== alarmCase.ecvSatisfied) {
      await alarmCase.update({ ecvSatisfied, updatedById: actorId || null });
    }

    const label: Record<string, string> = {
      contacted: 'contactado', no_answer: 'sin respuesta', verified_real: 'verificada REAL',
      verified_false: 'verificada FALSA', cancel_passcode: 'cancelada (contraseña)',
    };
    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'ecv.call',
      detail: `Llamada ${body.contactName ? `a ${body.contactName} ` : ''}— ${label[outcome] || outcome}${body.note ? `: ${body.note}` : ''}`,
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    await emitAlarmEvent(db, tenantId, { eventType: 'alarm.case.updated', title: 'Verificación por llamada', caseId: alarmCase.id, payload: { ecvSatisfied } });

    await ApiResponseHandler.success(req, res, {
      call: typeof call.get === 'function' ? call.get({ plain: true }) : call,
      ecvSatisfied,
      attempts,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
