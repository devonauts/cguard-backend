import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';

/**
 * Create a task for a station from the supervisor app's "Create Task" screen.
 * Supervisor-created tasks are staff-sourced + auto-approved so they land
 * straight on the station's to-do. Supports title, description, priority, due
 * date, optional assigned guard, repeat rule, photo/video attachments
 * (imageOptional relation) and a voice note (voiceNote relation). Gated
 * `supervisorMe`.
 *
 * POST /tenant/:tenantId/supervisor/me/stations/:stationId/tasks
 * body: { taskToDo, description?, priority?, dueDate?, assignedGuardId?,
 *         repeatConfig?, attachments?: File[], voiceNote?: File[] }
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

    let repeatConfig: string | null = null;
    if (data.repeatConfig != null) {
      repeatConfig =
        typeof data.repeatConfig === 'string' ? data.repeatConfig : JSON.stringify(data.repeatConfig);
    }

    const task = await db.task.create({
      tenantId,
      taskToDo: taskToDo.slice(0, 300),
      description: data.description ? String(data.description).slice(0, 500) : null,
      dateToDoTheTask: Number.isNaN(due.getTime()) ? new Date() : due,
      priority,
      status: 'approved',
      source: 'staff',
      approvedById: req.currentUser.id,
      approvedAt: new Date(),
      taskBelongsToStationId: stationId,
      assignedGuardId: data.assignedGuardId || null,
      repeatConfig,
      wasItDone: false,
    });

    // Link uploaded attachments (photos/videos) + voice note, best-effort.
    const fileOptions = {
      database: db,
      currentUser: req.currentUser,
      currentTenant: { id: tenantId },
    };
    const linkFiles = async (files: any, column: string) => {
      const list = Array.isArray(files) ? files : files ? [files] : [];
      if (!list.length) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const FileRepository = require('../../database/repositories/fileRepository').default;
        await FileRepository.replaceRelationFiles(
          { belongsTo: db.task.getTableName(), belongsToColumn: column, belongsToId: task.id },
          list,
          fileOptions,
        );
      } catch (e: any) {
        console.warn(`[supervisor.createStationTask] link ${column} failed:`, e?.message || e);
      }
    };
    await linkFiles(data.attachments, 'imageOptional');
    await linkFiles(data.voiceNote, 'voiceNote');

    // Approved on creation → push the station guards (worker app) + notify the
    // CRM/client (templates + preferences). Best-effort, never blocks the create.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { notifyTaskApproved } = require('../../services/taskNotify');
      notifyTaskApproved(
        db,
        tenantId,
        task.get ? task.get({ plain: true }) : task,
      ).catch(() => undefined);
    } catch (e: any) {
      console.warn('[supervisor.createStationTask] notify failed:', e?.message || e);
    }

    await ApiResponseHandler.success(req, res, {
      task: { id: task.id, taskToDo, priority, status: 'approved' },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default createStationTask;
