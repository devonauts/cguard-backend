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
    const stationId = b.stationId || b.taskBelongsToStation || null;
    const dateToDoTheTask = b.dateToDoTheTask ? new Date(b.dateToDoTheTask) : null;

    if (!taskToDo) return ApiResponseHandler.error(req, res, new Error('taskToDo requerido'));
    if (!stationId) return ApiResponseHandler.error(req, res, new Error('stationId requerido'));
    if (!dateToDoTheTask || isNaN(dateToDoTheTask.getTime())) {
      return ApiResponseHandler.error(req, res, new Error('dateToDoTheTask inválido'));
    }

    // Security: the station must belong to THIS client (its stationOrigin clientAccount).
    const station = await db.station.findOne({
      where: { id: stationId, tenantId, deletedAt: null },
      include: [{ model: db.clientAccount, as: 'stationOrigin', attributes: ['id'], required: false }],
    });
    if (!station || !station.stationOrigin || String(station.stationOrigin.id) !== String(clientAccountId)) {
      return ApiResponseHandler.error(req, res, new Error('Estación no válida para este cliente'));
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
