/**
 * POST /api/tenant/:tenantId/guard/me/patrol/finish  { tourId }
 *
 * The guard tapped "finalizar" in the app. If every checkpoint was scanned the
 * assignment already auto-completed on the last scan (siteTourService) — this
 * is then a no-op. If the round is INCOMPLETE, ops gets the "ronda perdida o
 * incompleta" alert immediately (per notifyTenantOnMissed) instead of waiting
 * for the overdue sweep, and the early finish is stamped on the assignment.
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

    const assignment = await db.tourAssignment.findOne({
      where: { siteTourId: tourId, status: 'assigned', tenantId },
    });
    // Nothing active (or it already auto-completed) → nothing to report.
    if (!assignment || !assignment.startAt) {
      return ApiResponseHandler.success(req, res, { ok: true, completed: true });
    }

    const [total, scanned] = await Promise.all([
      db.siteTourTag.count({ where: { siteTourId: tourId } }),
      db.tagScan.count({ where: { tourAssignmentId: assignment.id }, distinct: true, col: 'siteTourTagId' }),
    ]);

    if (total > 0 && scanned >= total) {
      // Complete — the last scan's auto-completion may still be in flight;
      // make it deterministic here.
      if (assignment.status !== 'completed') {
        await assignment.update({ status: 'completed', endAt: new Date() });
      }
      return ApiResponseHandler.success(req, res, { ok: true, completed: true });
    }

    // Incomplete early finish: stamp + alert ops now (dedupe vs the sweep).
    await assignment.update({ endAt: new Date(), missedNotifiedAt: new Date() });

    const settings = await resolveRondaSettings(db, tenantId, tour.postSiteId);
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
      attributes: ['fullName'],
    });
    notifyPatrol(db, {
      tenantId,
      postSiteId: tour.postSiteId,
      event: 'missed',
      routeName: tour.name,
      guardName: securityGuard?.fullName,
      settings,
      detail: `finalizada incompleta: ${scanned} de ${total} puntos`,
    }).catch(() => {});

    await ApiResponseHandler.success(req, res, { ok: true, completed: false, scanned, total });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
