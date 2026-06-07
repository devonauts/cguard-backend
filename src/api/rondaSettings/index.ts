import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

const FIELDS = [
  'frequencyMinutes', 'roundsPerShift', 'graceMinutes', 'maxDurationMinutes',
  'requirePhoto', 'requireGeofence', 'geofenceRadius', 'requireNote',
  'notifyTenantOnStart', 'notifyTenantOnComplete', 'notifyTenantOnMissed',
  'notifyClient', 'emailOnComplete', 'active',
];

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
  emailOnComplete: false,
  active: true,
};

const pick = (src: any) =>
  FIELDS.reduce((acc: any, k) => {
    if (typeof src[k] !== 'undefined') acc[k] = src[k];
    return acc;
  }, {});

export default (app) => {
  // GET effective ronda settings (tenant default, or per-post override).
  app.get('/tenant/:tenantId/ronda-settings', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const postSiteId = req.query.postSiteId || null;

      // Per-post override first, else the tenant default (postSiteId null).
      let record: any = null;
      if (postSiteId) {
        record = await db.rondaSettings.findOne({ where: { tenantId, postSiteId } });
      }
      if (!record) {
        record = await db.rondaSettings.findOne({ where: { tenantId, postSiteId: null } });
      }

      const out = record ? record.get({ plain: true }) : { ...DEFAULTS, id: null, postSiteId };
      out.isDefault = !record || !record.postSiteId;
      return ApiResponseHandler.success(req, res, out);
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  // PUT upsert ronda settings (tenant default or per-post override).
  app.put('/tenant/:tenantId/ronda-settings', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.postSiteEdit);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const currentUser = req.currentUser;
      const data = req.body.data || req.body || {};
      const postSiteId = data.postSiteId || null;

      let record = await db.rondaSettings.findOne({ where: { tenantId, postSiteId } });
      const values = { ...pick(data), tenantId, postSiteId, updatedById: currentUser && currentUser.id };

      if (record) {
        await record.update(values);
      } else {
        record = await db.rondaSettings.create({
          ...DEFAULTS,
          ...values,
          createdById: currentUser && currentUser.id,
        });
      }

      const out = record.get({ plain: true });
      out.isDefault = !record.postSiteId;
      return ApiResponseHandler.success(req, res, out);
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
};
