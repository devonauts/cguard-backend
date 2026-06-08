/**
 * POST /tenant/:tenantId/alarm/case/:id/dispatch
 * Body: { type, target, note, eta? }
 *
 * Dispatch a responder (guard|police|fire|medical) for an alarm case. Creates
 * an alarmDispatch row, moves the case to `dispatched` and stamps dispatchAt +
 * dispatchId. For a guard dispatch it best-effort pushes a notification to the
 * tenant's devices. Writes an audit log row.
 * Tenant-scoped; requires businessInfoEdit.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import { emitAlarmEvent } from '../../services/alarm/realtime';
import Error400 from '../../errors/Error400';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);

    const db = req.database;
    const tenantId = req.currentTenant.id;
    const currentUser = (req as any).currentUser;
    const actorId = currentUser && currentUser.id;

    const body = req.body || {};
    const type = body.type;
    const target = body.target || null;
    const note = body.note || null;
    if (!type) throw new Error400(req.language, 'alarm.dispatchTypeRequired');

    const alarmCase = await db.alarmCase.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!alarmCase) throw new Error404();

    const now = new Date();

    // Police dispatch: enforce Enhanced Call Verification (for burglary) and
    // route via ASAP-to-PSAP when configured, else a manual PSAP contact.
    // Hold-up/panic/fire/medical are ECV-exempt (immediate dispatch).
    let policeResult: any = null;
    if (type === 'police') {
      const ECV_EXEMPT = ['holdup', 'panic', 'fire', 'medical'];
      if (!ECV_EXEMPT.includes(alarmCase.category) && !alarmCase.ecvSatisfied && !body.override) {
        throw new Error400(req.language, 'alarm.ecvRequired');
      }
      const panel = await db.alarmPanel.findByPk(alarmCase.alarmPanelId);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dispatchPolice } = require('../../services/alarm/policeDispatch');
      policeResult = await dispatchPolice(panel, alarmCase, { note });
      if (policeResult.ref) await alarmCase.update({ asapRef: policeResult.ref });
    }

    const dispatch = await db.alarmDispatch.create({
      alarmCaseId: alarmCase.id,
      type,
      target: target || (policeResult ? policeResult.agency : null),
      status: 'requested',
      eta: body.eta ? new Date(body.eta) : null,
      outcome: policeResult ? policeResult.message : note,
      dispatchedById: actorId || null,
      tenantId,
    });

    await alarmCase.update({
      status: 'dispatched',
      dispatchId: dispatch.id,
      dispatchAt: alarmCase.dispatchAt || now,
      updatedById: actorId || null,
    });

    // Best-effort guard push notification — never blocks the dispatch.
    if (type === 'guard') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pushService = require('../../services/pushService');
        if (pushService && typeof pushService.pushToTenant === 'function') {
          await pushService
            .pushToTenant(db, tenantId, {
              title: 'Despacho de alarma',
              body: target
                ? `Guardia solicitado: ${target}`
                : 'Guardia solicitado para un caso de alarma',
              data: {
                type: 'alarm.dispatch',
                alarmCaseId: String(alarmCase.id),
                dispatchId: String(dispatch.id),
              },
            })
            .catch(() => {});
        }
      } catch (e: any) {
        console.warn('[alarm] guard dispatch push failed', e?.message || e);
      }
    }

    await db.alarmAuditLog.create({
      alarmCaseId: alarmCase.id,
      action: 'dispatch',
      detail: policeResult
        ? `Despacho policía (${policeResult.mode === 'asap' ? 'ASAP' : 'manual'}) — ${policeResult.message}`
        : `Despacho ${type}${target ? ` -> ${target}` : ''}${note ? ` (${note})` : ''}`,
      actorId: actorId || null,
      at: now,
      tenantId,
    });

    await emitAlarmEvent(db, tenantId, { eventType: 'alarm.case.updated', title: 'Caso despachado', caseId: alarmCase.id, payload: { status: 'dispatched', dispatchType: type } });

    const plain =
      typeof dispatch.get === 'function' ? dispatch.get({ plain: true }) : dispatch;
    await ApiResponseHandler.success(req, res, { ...plain, police: policeResult || undefined });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
