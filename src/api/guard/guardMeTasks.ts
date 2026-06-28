/**
 * Worker-app tasks (the guard's shift to-do).
 *   GET  /tenant/:tenantId/guard/me/tasks            → approved, not-done tasks for the
 *                                                       guard's active station(s)
 *   POST /tenant/:tenantId/guard/me/tasks/:id/complete { notes?, photo? }
 *                                                     → mark done (saves the guard's
 *                                                       completion note + optional
 *                                                       photo) + notify the client
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error404 from '../../errors/Error404';
import FileRepository from '../../database/repositories/fileRepository';
import { notifyTaskCompleted } from '../../services/taskNotify';

/** Station ids the guard is actively assigned to. */
async function activeStationIds(db: any, tenantId: string, userId: string): Promise<string[]> {
  const rows = await db.guardAssignment.findAll({
    where: { tenantId, guardId: userId, status: 'active', deletedAt: null },
    attributes: ['stationId'],
  });
  return Array.from(new Set((rows || []).map((r: any) => String(r.stationId)).filter(Boolean)));
}

export const guardMeTasksList = async (req, res) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const stationIds = await activeStationIds(db, tenantId, currentUser.id);
    if (!stationIds.length) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0 });
    }
    const rows = await db.task.findAll({
      where: {
        tenantId,
        deletedAt: null,
        status: 'approved',
        wasItDone: false,
        taskBelongsToStationId: { [Op.in]: stationIds },
      },
      include: [{ model: db.station, as: 'taskBelongsToStation', attributes: ['id', 'stationName'] }],
      order: [['dateToDoTheTask', 'ASC']],
      limit: 200,
    });
    await ApiResponseHandler.success(req, res, {
      rows: rows.map((r: any) => r.get({ plain: true })),
      count: rows.length,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const guardMeTaskComplete = async (req, res) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const b = req.body?.data || req.body || {};

    const stationIds = await activeStationIds(db, tenantId, currentUser.id);
    const task = await db.task.findOne({
      where: { id: req.params.id, tenantId, deletedAt: null },
    });
    if (!task) throw new Error404();
    // Only a guard assigned to the task's station may complete it.
    if (!stationIds.includes(String(task.taskBelongsToStationId))) {
      return ApiResponseHandler.error(req, res, new Error('Tarea no asignada a tu puesto'));
    }

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: currentUser.id, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });

    // What the guard reported doing (free text, capped). Trimmed empty → null.
    const completionNotes =
      typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 1000) : null;

    await task.update({
      wasItDone: true,
      status: 'completed',
      dateCompletedTask: new Date(),
      completedByGuardId: securityGuard ? securityGuard.id : null,
      completionNotes,
      updatedById: currentUser.id,
    });

    // Optional completion photo (taskCompletedImage file relation) → resolve a URL
    // for the client notification image.
    let photoUrl = '';
    try {
      if (Array.isArray(b.photo) && b.photo.length) {
        await FileRepository.replaceRelationFiles(
          { belongsTo: db.task.getTableName(), belongsToColumn: 'taskCompletedImage', belongsToId: task.id },
          b.photo,
          { database: db, currentUser, currentTenant: { id: tenantId } } as any,
        );
      }
      const files = await db.file.findAll({
        where: { belongsTo: db.task.getTableName(), belongsToColumn: 'taskCompletedImage', belongsToId: task.id },
      });
      const filled = await FileRepository.fillDownloadUrl(files);
      photoUrl = (filled[0] && (filled[0].downloadUrl || filled[0].publicUrl)) || '';
    } catch (e: any) {
      console.warn('[guardTask] completion photo failed:', e?.message || e);
    }

    notifyTaskCompleted(db, tenantId, task.get({ plain: true }), {
      guardName: securityGuard ? securityGuard.fullName : undefined,
      photoUrl,
      notes: completionNotes || undefined,
    }).catch(() => undefined);

    await ApiResponseHandler.success(req, res, task.get({ plain: true }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
