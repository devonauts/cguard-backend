/**
 * Client-app tasks API (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). A client creates a task for one of THEIR stations;
 * it lands as `pending_approval` and notifies the CRM. Lists the client's own tasks.
 *
 *   POST /customer/tasks   { taskToDo, dateToDoTheTask, stationId, priority? }
 *   GET  /customer/tasks
 */
import { Op } from 'sequelize';
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

    // The client's stations come from TWO places: stations linked directly
    // (stationOrigin = this client) AND stations under the client's post-sites
    // (businessInfo.clientAccountId → station.postSiteId). We accept both.
    const [originStations, postSites] = await Promise.all([
      db.station.findAll({ where: { tenantId, stationOriginId: clientAccountId, deletedAt: null }, attributes: ['id'] }),
      db.businessInfo.findAll({ where: { tenantId, clientAccountId, deletedAt: null }, attributes: ['id'] }),
    ]);
    const myStationIds = new Set<string>((originStations || []).map((s: any) => String(s.id)));
    const postSiteIds = (postSites || []).map((b2: any) => String(b2.id));
    if (postSiteIds.length) {
      const psStations = await db.station.findAll({
        where: { tenantId, postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
        attributes: ['id'],
      });
      for (const s of psStations || []) myStationIds.add(String(s.id));
    }

    if (stationId) {
      // Explicit station must belong to this client.
      if (!myStationIds.has(String(stationId))) {
        return ApiResponseHandler.error(req, res, new Error('Estación no válida para este cliente'));
      }
    } else if (myStationIds.size) {
      // None provided (current client app) → use the client's first station.
      stationId = Array.from(myStationIds)[0];
    } else {
      // Client has no resolvable station → create a station-less task (the CRM can
      // assign a station/guards on approval). Never block the client here.
      stationId = null;
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
