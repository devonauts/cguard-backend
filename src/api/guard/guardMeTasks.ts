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
import Error403 from '../../errors/Error403';
import Error404 from '../../errors/Error404';
import FileRepository from '../../database/repositories/fileRepository';
import { notifyTaskCompleted } from '../../services/taskNotify';
import { stationIdsForGuard } from '../../services/assignedStationsService';

/**
 * Every station the guard is effectively working — so tasks SHOW and can be
 * COMPLETED whether they're tied to the post via an active assignment, the
 * permanent station junction, the current scheduled shift, OR an open clock-in.
 * Relying on guardAssignment alone left scheduler/clock-in guards with an empty
 * task list and a "not assigned to your post" rejection on complete.
 */
async function guardStationIds(db: any, tenantId: string, userId: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (v: any) => { if (v) ids.add(String(v)); };

  // 1) Active guard assignments.
  try {
    const rows = await db.guardAssignment.findAll({
      where: { tenantId, guardId: userId, status: 'active', deletedAt: null },
      attributes: ['stationId'],
    });
    for (const r of rows || []) add(r.stationId);
  } catch (e) { console.warn('[guardTasks] assignment stations failed:', (e as any)?.message || e); }

  // 2) Active guardAssignment stations (single source of truth; the old
  //    stationAssignedGuardsUser junction is dead).
  try {
    for (const id of await stationIdsForGuard(db, tenantId, userId)) add(id);
  } catch (e) { console.warn('[guardTasks] assignment stations failed:', (e as any)?.message || e); }

  // 3) Current scheduled shift (now within the window).
  try {
    const now = new Date();
    const shift = await db.shift.findOne({
      where: { guardId: userId, tenantId, startTime: { [Op.lte]: now }, endTime: { [Op.gte]: now } },
      attributes: ['stationId'],
      order: [['startTime', 'DESC']],
    });
    if (shift) add(shift.stationId);
  } catch (e) { console.warn('[guardTasks] shift station failed:', (e as any)?.message || e); }

  // 4) Active clock-in (guardShift still open) — where the guard physically is.
  try {
    const sg = await db.securityGuard.findOne({ where: { guardId: userId, tenantId, deletedAt: null }, attributes: ['id'] });
    if (sg) {
      const cs = await db.guardShift.findOne({
        where: { guardNameId: sg.id, tenantId, punchOutTime: null },
        attributes: ['stationNameId'],
        order: [['punchInTime', 'DESC']],
      });
      if (cs) add(cs.stationNameId);
    }
  } catch (e) { console.warn('[guardTasks] clock-in station failed:', (e as any)?.message || e); }

  return Array.from(ids);
}

export const guardMeTasksList = async (req, res) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const stationIds = await guardStationIds(db, tenantId, currentUser.id);
    if (!stationIds.length) {
      return ApiResponseHandler.success(req, res, { rows: [], count: 0 });
    }
    const rows = await db.task.findAll({
      where: {
        tenantId,
        deletedAt: null,
        taskBelongsToStationId: { [Op.in]: stationIds },
        [Op.or]: [
          // Pending: approved + not yet done.
          { status: 'approved', wasItDone: false },
          // Also return RECENTLY completed tasks so the guard can tap them and review
          // the detail (what was reported, photo, when). Last 14 days.
          { status: 'completed', dateCompletedTask: { [Op.gte]: new Date(Date.now() - 14 * 864e5) } },
        ],
      },
      include: [
        { model: db.station, as: 'taskBelongsToStation', attributes: ['id', 'stationName'] },
        { model: db.file, as: 'taskCompletedImage', required: false },
        { model: db.file, as: 'imageOptional', required: false },
      ],
      order: [['wasItDone', 'ASC'], ['dateToDoTheTask', 'ASC']],
      limit: 200,
    });
    // Sign the file relations so the app can render the completion photo + the
    // client's optional reference image in the task detail screen.
    const plain = rows.map((r: any) => r.get({ plain: true }));
    for (const p of plain) {
      p.taskCompletedImage = await FileRepository.fillDownloadUrl(p.taskCompletedImage || []);
      p.imageOptional = await FileRepository.fillDownloadUrl(p.imageOptional || []);
    }
    await ApiResponseHandler.success(req, res, { rows: plain, count: plain.length });
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

    const stationIds = await guardStationIds(db, tenantId, currentUser.id);
    const task = await db.task.findOne({
      where: { id: req.params.id, tenantId, deletedAt: null },
    });
    if (!task) throw new Error404();
    // Only a guard working the task's station may complete it. (Same resolver as
    // the list, so any task the guard can SEE is always completable.)
    if (!stationIds.includes(String(task.taskBelongsToStationId))) {
      throw new Error403();
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
