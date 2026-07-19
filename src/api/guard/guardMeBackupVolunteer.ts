/**
 * POST /api/tenant/:tenantId/guard/me/backup/volunteer
 * body.data = { shiftId?, stationId?, eventDate?, notes? }
 * The authenticated guard offers to cover a shift. Earns volunteer points
 * toward the backup bonus; a supervisor later confirms actual coverage.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import BackupService from '../../services/backupService';
import { dispatch } from '../../lib/notificationDispatcher';

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
      attributes: ['id', 'fullName'],
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

    // CRM realtime feed (bell): supervisors/admins see the offer, like every
    // other guard action. Best-effort, fire-and-forget — never blocks the action.
    try {
      let stationName: any = null;
      let postSiteId: any;
      if (stationId) {
        const st = await db.station.findByPk(stationId, {
          attributes: ['stationName', 'postSiteId'],
        });
        stationName = (st && st.stationName) || null;
        postSiteId = (st && st.postSiteId) || undefined;
      }
      await dispatch(
        'backup.volunteered',
        {
          guardName: (securityGuard && securityGuard.fullName) || currentUser.fullName || 'Un guardia',
          stationName,
          eventDate,
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'backupEvent',
          sourceEntityId: (ev as any) && (ev as any).id,
          assignedPostSiteId: postSiteId,
        },
      );
    } catch (e) {
      console.error('[backupVolunteer] dispatch failed:', (e as any)?.message || e);
    }

    return ApiResponseHandler.success(req, res, ev);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
