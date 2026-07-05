/**
 * POST /tenant/:tenantId/incident/:id/assign-supervisor { supervisorUserId, name? }
 *
 * Dispatch an incident TO a supervisor: assign it to them and notify that
 * specific supervisor (in-app + realtime, targeted by recipientUserId). The
 * supervisor then acknowledges via /supervisor/me/incidents/:id/respond
 * (accepted → enRoute → onScene). Fills the audit's "no inbound dispatch to the
 * supervisor" gap. Gated by incidentEdit (admins/dispatchers/supervisors hold it).
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import { storePlatformEvent } from '../../lib/platformEventStore';

export default async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.incidentEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const data = (req.body && req.body.data) || req.body || {};
    const supervisorUserId = data.supervisorUserId ? String(data.supervisorUserId) : null;
    if (!supervisorUserId) throw new Error400(req.language, undefined, 'supervisorUserId is required');

    const incident = await db.incident.findOne({ where: { id: req.params.id, tenantId } });
    if (!incident) throw new Error404(req.language);

    await incident.update({
      assignedToUserId: supervisorUserId,
      dispatchStatus: 'dispatched',
      dispatchedAt: new Date(),
      updatedById: req.currentUser?.id || null,
    });

    // Targeted notify: only this supervisor. eventType starts with "incident."
    // so the supervisor app's incidents screen live-refreshes.
    try {
      await storePlatformEvent(db, {
        tenantId,
        eventType: 'incident.dispatched',
        title: 'Incidente despachado',
        body: incident.title || 'Se te asignó un incidente',
        recipientUserId: supervisorUserId,
        sourceEntityType: 'incident',
        sourceEntityId: String(incident.id),
        payload: { incidentId: String(incident.id), title: incident.title || null },
      });
    } catch { /* realtime best-effort */ }

    await ApiResponseHandler.success(req, res, {
      id: String(incident.id),
      assignedToUserId: supervisorUserId,
      dispatchStatus: 'dispatched',
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
