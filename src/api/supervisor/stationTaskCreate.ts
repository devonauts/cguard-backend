import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';

/**
 * Create a task for a station from the supervisor app (Station Details → Add
 * Task). Supervisor-created tasks are staff-sourced and auto-approved so they
 * land straight on the station's to-do. Gated `supervisorMe`.
 *
 * POST /tenant/:tenantId/supervisor/me/stations/:stationId/tasks
 * body: { taskToDo, priority?: 'alta'|'media'|'baja', dueDate? }
 */
export const createStationTask = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const stationId = String(req.params.stationId);
    const data = (req.body && req.body.data) || req.body || {};

    const taskToDo = String(data.taskToDo || '').trim();
    if (!taskToDo) throw new Error400(req.language, 'validation.required');

    // Confirm the station belongs to this tenant before attaching a task to it.
    const station = await db.station.findOne({
      where: { id: stationId, tenantId },
      attributes: ['id'],
    });
    if (!station) throw new Error400(req.language);

    const priority = ['alta', 'media', 'baja'].includes(data.priority) ? data.priority : 'media';
    const due = data.dueDate ? new Date(data.dueDate) : new Date();

    const task = await db.task.create({
      tenantId,
      taskToDo: taskToDo.slice(0, 300),
      dateToDoTheTask: Number.isNaN(due.getTime()) ? new Date() : due,
      priority,
      status: 'approved',
      source: 'staff',
      approvedById: req.currentUser.id,
      approvedAt: new Date(),
      taskBelongsToStationId: stationId,
      wasItDone: false,
    });

    await ApiResponseHandler.success(req, res, {
      task: { id: task.id, taskToDo, priority, status: 'approved' },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default createStationTask;
