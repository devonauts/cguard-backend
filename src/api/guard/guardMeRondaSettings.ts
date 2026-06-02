/**
 * GET /api/tenant/:tenantId/guard/me/ronda-settings
 *
 * Effective patrol configuration for the authenticated guard's post site
 * (per-post override, else tenant default, else sensible defaults). Lets the
 * worker app enforce photo/geofence/note requirements without admin permission.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';

const DEFAULTS = {
  frequencyMinutes: 60,
  roundsPerShift: null,
  graceMinutes: 10,
  maxDurationMinutes: 60,
  requirePhoto: true,
  requireGeofence: true,
  geofenceRadius: 50,
  requireNote: false,
  notifyTenantOnStart: true,
  notifyTenantOnComplete: true,
  notifyTenantOnMissed: true,
  notifyClient: false,
  active: true,
};

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();
    const db = req.database;
    const userId = currentUser.id;
    const tenantId =
      req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    // Resolve the guard's station → postSiteId (query param override allowed).
    let postSiteId = req.query.postSiteId || null;
    if (!postSiteId) {
      const station = await db.station
        .findOne({
          where: { tenantId, deletedAt: null },
          include: [
            {
              model: db.user,
              as: 'assignedGuards',
              where: { id: userId },
              attributes: [],
              through: { attributes: [] },
              required: true,
            },
          ],
          attributes: ['id', 'postSiteId'],
        })
        .catch(() => null);
      postSiteId = station ? station.postSiteId : null;
    }

    let record = null;
    if (postSiteId) {
      record = await db.rondaSettings.findOne({ where: { tenantId, postSiteId } });
    }
    if (!record) {
      record = await db.rondaSettings.findOne({ where: { tenantId, postSiteId: null } });
    }

    const out = record ? record.get({ plain: true }) : { ...DEFAULTS, id: null, postSiteId };
    return ApiResponseHandler.success(req, res, out);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
