/**
 * Client-app tasks API (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). A client creates a task for one of THEIR stations;
 * it lands as `pending_approval` and notifies the CRM. Lists the client's own tasks.
 *
 *   POST /customer/tasks   { taskToDo, dateToDoTheTask, stationId, priority? }
 *   GET  /customer/tasks
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import { notifyTaskPending } from '../../services/taskNotify';

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

export const customerTaskCreate = async (req, res) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};
    const taskToDo = String(b.taskToDo || b.task || '').trim();
    let stationId = b.stationId || b.taskBelongsToStation || null;
    // dateToDoTheTask defaults to +1 day so the existing client app (which may not
    // send one) still works.
    const dateToDoTheTask = b.dateToDoTheTask ? new Date(b.dateToDoTheTask) : new Date(Date.now() + 86400000);

    if (!taskToDo) return ApiResponseHandler.error(req, res, new Error('taskToDo requerido'));
    if (isNaN(dateToDoTheTask.getTime())) {
      return ApiResponseHandler.error(req, res, new Error('dateToDoTheTask inválido'));
    }

    // The client's own stations (stationOrigin = this clientAccount). Resolved via
    // the association so we don't depend on the raw FK column name.
    const myStations = await db.station.findAll({
      where: { tenantId, deletedAt: null },
      attributes: ['id'],
      include: [{
        model: db.clientAccount, as: 'stationOrigin', attributes: ['id'],
        required: true, where: { id: clientAccountId },
      }],
    });
    const myStationIds = (myStations || []).map((s: any) => String(s.id));
    if (!myStationIds.length) {
      return ApiResponseHandler.error(req, res, new Error('No hay estaciones asociadas a este cliente'));
    }
    if (stationId) {
      // Explicit station must belong to this client.
      if (!myStationIds.includes(String(stationId))) {
        return ApiResponseHandler.error(req, res, new Error('Estación no válida para este cliente'));
      }
    } else {
      // None provided (current client app) → default to the client's (only) station.
      stationId = myStationIds[0];
    }

    const priority = ['alta', 'media', 'baja'].includes(b.priority) ? b.priority : 'media';
    const task = await db.task.create({
      taskToDo,
      dateToDoTheTask,
      wasItDone: false,
      status: 'pending_approval',
      source: 'client',
      priority,
      clientAccountId,
      taskBelongsToStationId: stationId,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    notifyTaskPending(db, tenantId, task.get({ plain: true })).catch(() => undefined);

    await ApiResponseHandler.success(req, res, task.get({ plain: true }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const customerTaskList = async (req, res) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const rows = await db.task.findAll({
      where: { tenantId, clientAccountId, deletedAt: null },
      include: [{ model: db.station, as: 'taskBelongsToStation', attributes: ['id', 'stationName'] }],
      order: [['createdAt', 'DESC']],
      limit: Math.min(parseInt((req.query || {}).limit, 10) || 100, 200),
    });
    await ApiResponseHandler.success(req, res, {
      rows: rows.map((r: any) => r.get({ plain: true })),
      count: rows.length,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
