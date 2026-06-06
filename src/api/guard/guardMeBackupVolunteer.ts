/**
 * POST /api/tenant/:tenantId/guard/me/backup/volunteer
 * body.data = { shiftId?, stationId?, eventDate?, notes? }
 * The authenticated guard offers to cover a shift. Earns volunteer points
 * toward the backup bonus; a supervisor later confirms actual coverage.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import BackupService from '../../services/backupService';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);
    const data = (req.body && req.body.data) || req.body || {};

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id'],
    });

    let stationId = data.stationId || null;
    let eventDate = data.eventDate || null;
    if (data.shiftId && (!stationId || !eventDate)) {
      const shift = await db.shift.findOne({
        where: { id: data.shiftId, tenantId, deletedAt: null },
        attributes: ['stationId', 'startTime'],
      });
      if (shift) {
        stationId = stationId || shift.stationId;
        eventDate =
          eventDate ||
          (shift.startTime
            ? new Date(shift.startTime).toISOString().slice(0, 10)
            : null);
      }
    }

    const ev = await BackupService.volunteer(db, {
      tenantId,
      subjectUserId: userId,
      securityGuardId: securityGuard?.id || null,
      subjectType: securityGuard ? 'guard' : 'supervisor',
      shiftId: data.shiftId || null,
      stationId,
      eventDate,
      notes: data.notes || null,
      createdById: userId,
    });

    return ApiResponseHandler.success(req, res, ev);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
