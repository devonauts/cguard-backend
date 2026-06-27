/**
 * Client-app visitor-removal request (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). A customer asks that a visitor be REMOVED from
 * one of their installations. This:
 *   1. creates a TASK exactly like a normal customer task (source:'client',
 *      status:'pending_approval', stationId, clientAccountId) so it lands in the
 *      worker/guard app + CRM and notifies the CRM via notifyTaskPending, AND
 *   2. fires a best-effort push to the station's on-duty guards so they see the
 *      removal request immediately.
 *
 *   POST /customer/visitor-log/:id/request-removal   { reason? }
 *   → 200 { success, message, taskId }   404 if the visitor isn't the client's.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import Error404 from '../../errors/Error404';
import VisitorLogService from '../../services/visitorLogService';
import { notifyTaskPending, stationGuardUserIds } from '../../services/taskNotify';
import { pushToUser } from '../../services/pushService';

const DEBUG = process.env.DEBUG_VISITOR_REMOVAL === '1';
const dbg = (...args: any[]) => { if (DEBUG) console.debug('[visitorRemoval]', ...args); };

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

export const customerVisitorRemovalRequest = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const visitorLogId = req.params.id;
    const b = req.body?.data || req.body || {};
    const reason = String(b.reason || '').trim();

    // Resolve the visitor scoped to THIS customer. VisitorLogService(req).findById
    // runs the repository's customer-ACL (posts belonging to the client account),
    // so a visitor that isn't the client's throws Error404 — exactly what we want.
    // Pass explicit currentTenant so the ACL is tenant-scoped even on customer
    // routes where tenantMiddleware may not have stamped req.currentTenant.
    let visit: any;
    try {
      visit = await new VisitorLogService({
        ...req,
        currentUser: req.currentUser,
        currentTenant: { id: tenantId },
        database: db,
        language: req.language,
      }).findById(visitorLogId);
    } catch (e) {
      throw new Error404();
    }
    if (!visit) throw new Error404();

    const stationId = visit.stationId || null;
    const stationName = visit.stationName || (visit.station && visit.station.stationName) || 'el puesto';
    const firstName = (visit.firstName || '').trim();
    const lastName = (visit.lastName || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'el visitante';
    const idNumber = (visit.idNumber || '').trim();

    // ── Idempotent dedupe: if this client already has an OPEN removal task for the
    // same visitor, don't create a second one — return 200 with an idempotent
    // message (the contract allows this optional dedupe).
    const taskText =
      `Retirar al visitante ${fullName}` +
      (idNumber ? ` (cédula ${idNumber})` : '') +
      ` de ${stationName}.` +
      (reason ? ` Motivo: ${reason}` : '');

    let existing: any = null;
    try {
      existing = await db.task.findOne({
        where: {
          tenantId,
          clientAccountId,
          source: 'client',
          status: 'pending_approval',
          taskToDo: taskText,
          deletedAt: null,
        },
        order: [['createdAt', 'DESC']],
      });
    } catch (e: any) {
      dbg('dedupe lookup failed (non-fatal):', e?.message || e);
    }

    if (existing) {
      dbg('removal already requested, returning idempotently', { taskId: existing.id });
      return ApiResponseHandler.success(req, res, {
        success: true,
        message: `Ya se solicitó el retiro de ${fullName}. La guardia será notificada.`,
        taskId: String(existing.id),
      });
    }

    // ── Create the task exactly like customerTaskCreate: source 'client',
    // pending_approval, the visitor's station, this client account. dateToDoTheTask
    // defaults to +1 day so the worker app (which expects a deadline) renders it.
    const task = await db.task.create({
      taskToDo: taskText,
      dateToDoTheTask: new Date(Date.now() + 86400000),
      wasItDone: false,
      status: 'pending_approval',
      source: 'client',
      priority: 'alta',
      clientAccountId,
      taskBelongsToStationId: stationId,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    const taskId = String(task.id);
    const plainTask = task.get({ plain: true });

    // CRM notification — same path a normal customer task uses.
    notifyTaskPending(db, tenantId, plainTask).catch(() => undefined);

    // ── Guard push (best-effort; never fail the request on a push error). Resolve
    // the station's active guard USER ids (same helper notifyTaskApproved uses) and
    // push to each guard's registered worker-app devices.
    (async () => {
      try {
        const guardIds = stationId ? await stationGuardUserIds(db, tenantId, stationId) : [];
        dbg('guard user ids for station', stationId, '→', guardIds);
        await Promise.all(
          guardIds.map((uid) =>
            pushToUser(db, tenantId, uid, {
              title: 'Solicitud de retiro de visitante',
              body: taskText,
              data: {
                type: 'visitor_removal',
                visitorLogId: String(visitorLogId),
                taskId,
                stationId: String(stationId || ''),
              },
            }).catch((e: any) => { dbg('pushToUser failed', uid, e?.message || e); }),
          ),
        );
      } catch (e: any) {
        dbg('guard push fan-out failed (non-fatal):', e?.message || e);
      }
    })();

    return ApiResponseHandler.success(req, res, {
      success: true,
      message: `Solicitud de retiro de ${fullName} enviada. La guardia será notificada.`,
      taskId,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default customerVisitorRemovalRequest;
