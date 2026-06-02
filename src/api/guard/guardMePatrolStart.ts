/**
 * POST /api/tenant/:tenantId/guard/me/patrol/start  { tourId }
 *
 * Marks the start of a patrol: stamps the assignment's startAt and (per the
 * ronda settings) notifies the tenant/client that a patrol is in progress.
 * Returns the effective settings so the worker can enforce them.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { notifyPatrol, resolveRondaSettings } from '../../services/rondaNotify';

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const tourId = (req.body.data || req.body || {}).tourId;
    if (!tourId) throw new Error400(req.language, 'rondas.tourRequired');

    const tour = await db.siteTour.findOne({ where: { id: tourId, tenantId } });
    if (!tour) {
      const err: any = new Error('Tour not found');
      err.code = 404;
      throw err;
    }

    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });

    // Reuse the active assignment for this tour, else create one for this guard.
    let assignment = await db.tourAssignment.findOne({
      where: { siteTourId: tourId, status: 'assigned' },
    });
    if (!assignment) {
      assignment = await db.tourAssignment.create({
        siteTourId: tourId,
        securityGuardId: securityGuard ? securityGuard.id : null,
        postSiteId: tour.postSiteId || null,
        stationId: tour.stationId || null,
        status: 'assigned',
        startAt: new Date(),
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
    } else if (!assignment.startAt) {
      await assignment.update({
        startAt: new Date(),
        securityGuardId: assignment.securityGuardId || (securityGuard ? securityGuard.id : null),
      });
    }

    const settings = await resolveRondaSettings(db, tenantId, tour.postSiteId);

    notifyPatrol(db, {
      tenantId,
      postSiteId: tour.postSiteId,
      event: 'start',
      routeName: tour.name,
      guardName: securityGuard ? securityGuard.fullName : undefined,
      settings,
      createdById: userId,
    }).catch(() => {});

    return ApiResponseHandler.success(req, res, {
      assignmentId: assignment.id,
      startedAt: assignment.startAt,
      settings,
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
