import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Daily completion tracking for vehicle-patrol routes (the supervisor board).
 *   GET    /tenant/:tenantId/route-runs?date=YYYY-MM-DD   list runs for a day
 *   POST   /tenant/:tenantId/route/:routeId/run           mark a route done (upsert)
 *   DELETE /tenant/:tenantId/route/:routeId/run?date=...  undo (remove the run)
 */
export default (app) => {
  app.get('/tenant/:tenantId/route-runs', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.patrolRead);
      const db = req.database;
      const where: any = { tenantId: req.currentTenant.id };
      if (req.query.date) where.date = req.query.date;
      const rows = await db.routeRun.findAll({ where, order: [['completedAt', 'DESC']] });
      await ApiResponseHandler.success(req, res, { rows: rows.map((r: any) => r.get({ plain: true })), count: rows.length });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/route/:routeId/run', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.patrolCreate);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const data = (req.body && req.body.data) || req.body || {};
      const { tenantToday } = await import('../../services/assignmentService');
      const date = data.date || await tenantToday(req.database, req.currentTenant.id);
      const payload = {
        status: data.status || 'completed',
        completedAt: new Date(),
        note: data.note || null,
        completedByName: req.currentUser.fullName || req.currentUser.email || null,
        completedById: req.currentUser.id,
      };
      let run = await db.routeRun.findOne({ where: { tenantId, routeId: req.params.routeId, date } });
      if (run) await run.update(payload);
      else run = await db.routeRun.create({ ...payload, tenantId, routeId: req.params.routeId, date });
      await ApiResponseHandler.success(req, res, run.get({ plain: true }));
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.delete('/tenant/:tenantId/route/:routeId/run', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.patrolCreate);
      const db = req.database;
      const { tenantToday: _tt } = await import('../../services/assignmentService');
      const date = req.query.date || await _tt(req.database, req.currentTenant.id);
      const run = await db.routeRun.findOne({ where: { tenantId: req.currentTenant.id, routeId: req.params.routeId, date } });
      if (run) await run.destroy({ force: true });
      await ApiResponseHandler.success(req, res, { success: true });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
