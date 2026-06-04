import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

const FIELDS = ['title', 'description', 'time', 'recurrence', 'days', 'dayOfMonth', 'date', 'priority', 'active'];
const pick = (src: any = {}) =>
  FIELDS.reduce((acc: any, k) => {
    if (typeof src[k] !== 'undefined') acc[k] = src[k];
    return acc;
  }, {});

/**
 * Station "consignas específicas" — recurring standing orders for a station.
 *   GET    /tenant/:tenantId/station/:stationId/orders
 *   POST   /tenant/:tenantId/station/:stationId/orders
 *   PUT    /tenant/:tenantId/station/:stationId/orders/:id
 *   DELETE /tenant/:tenantId/station/:stationId/orders/:id
 */
export default (app) => {
  app.get('/tenant/:tenantId/station/:stationId/orders', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.stationRead);
      const db = req.database;
      const rows = await db.stationOrder.findAll({
        where: { tenantId: req.currentTenant.id, stationId: req.params.stationId },
        order: [['createdAt', 'DESC']],
      });
      await ApiResponseHandler.success(req, res, { rows: rows.map((r: any) => r.get({ plain: true })), count: rows.length });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/station/:stationId/orders', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const stationId = req.params.stationId;
      const station = await db.station.findOne({ where: { id: stationId, tenantId } });
      const data = (req.body && req.body.data) || req.body || {};
      const record = await db.stationOrder.create({
        ...pick(data),
        stationId,
        postSiteId: station?.postSiteId || null,
        tenantId,
        createdById: req.currentUser.id,
        updatedById: req.currentUser.id,
      });
      await ApiResponseHandler.success(req, res, record.get({ plain: true }));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.put('/tenant/:tenantId/station/:stationId/orders/:id', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
      const db = req.database;
      const record = await db.stationOrder.findOne({
        where: { id: req.params.id, tenantId: req.currentTenant.id, stationId: req.params.stationId },
      });
      if (!record) return ApiResponseHandler.success(req, res, { success: false, message: 'No encontrado' });
      const data = (req.body && req.body.data) || req.body || {};
      await record.update({ ...pick(data), updatedById: req.currentUser.id });
      await ApiResponseHandler.success(req, res, record.get({ plain: true }));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.delete('/tenant/:tenantId/station/:stationId/orders/:id', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.stationEdit);
      const db = req.database;
      const record = await db.stationOrder.findOne({
        where: { id: req.params.id, tenantId: req.currentTenant.id, stationId: req.params.stationId },
      });
      if (record) await record.destroy();
      await ApiResponseHandler.success(req, res, { success: true });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
