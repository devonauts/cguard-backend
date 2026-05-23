import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

export default (app) => {
  // KPIs for reports page
  app.get('/reports/kpis', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const startQ = String(req.query.start || '').trim();
      const endQ = String(req.query.end || '').trim();
      let start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (startQ && startQ.length >= 10) {
        const p = startQ.split('-');
        if (p.length === 3) start = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0));
      }
      let end = new Date(start.getTime());
      end.setUTCDate(end.getUTCDate() + 1);

      const { Op } = require('sequelize');
      const where = { createdAt: { [Op.gte]: start, [Op.lt]: end }, ...(tenantId ? { tenantId } : {}) };

      const db = req.database;
      const reportsCount = await db.report.count({ where });
      const incidentsCount = await db.incident.count({ where });
      const scansCount = await db.tagScan.count({ where: { scannedAt: { [Op.gte]: start, [Op.lt]: end }, ...(tenantId ? { tenantId } : {}) } });
      const guardsOnDuty = await db.securityGuard.count({ where: { ...(tenantId ? { tenantId } : {}), isOnDuty: true } });

      const out = [
        { id: 'reports_generated', label: 'Reportes generados', value: reportsCount },
        { id: 'incidents', label: 'Incidentes reportados', value: incidentsCount },
        { id: 'rondas', label: 'Rondas completadas', value: scansCount },
        { id: 'assistances', label: 'Asistencias', value: guardsOnDuty },
      ];

      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Series data for chart (group by day)
  app.get('/reports/series', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const startQ = String(req.query.start || '').trim();
      const endQ = String(req.query.end || '').trim();
      let start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (startQ && startQ.length >= 10) {
        const p = startQ.split('-');
        if (p.length === 3) start = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0));
      }
      let end = endQ && endQ.length >= 10 ? new Date(Date.UTC(Number(endQ.split('-')[0]), Number(endQ.split('-')[1]) - 1, Number(endQ.split('-')[2]), 0, 0, 0)) : new Date(start.getTime());
      if (end.getTime() === start.getTime()) end.setUTCDate(end.getUTCDate() + 1);

      const { fn, col, Op } = require('sequelize');
      const where = { createdAt: { [Op.gte]: start, [Op.lt]: end }, ...(tenantId ? { tenantId } : {}) };

      const rows = await req.database.report.findAll({
        attributes: [[fn('DATE', col('createdAt')), 'date'], [fn('COUNT', col('id')), 'value']],
        where,
        group: [fn('DATE', col('createdAt'))],
        order: [[fn('DATE', col('createdAt')), 'ASC']],
      });

      const out = rows.map((r: any) => ({ date: r.get('date'), value: Number(r.get('value')) }));
      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Reports by type
  app.get('/reports/by-type', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const startQ = String(req.query.start || '').trim();
      const endQ = String(req.query.end || '').trim();
      let start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (startQ && startQ.length >= 10) {
        const p = startQ.split('-');
        if (p.length === 3) start = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0));
      }
      let end = endQ && endQ.length >= 10 ? new Date(Date.UTC(Number(endQ.split('-')[0]), Number(endQ.split('-')[1]) - 1, Number(endQ.split('-')[2]), 0, 0, 0)) : new Date(start.getTime());
      if (end.getTime() === start.getTime()) end.setUTCDate(end.getUTCDate() + 1);

      const { fn, col, Op } = require('sequelize');
      const where = { createdAt: { [Op.gte]: start, [Op.lt]: end }, ...(tenantId ? { tenantId } : {}) };

      const rows = await req.database.report.findAll({
        attributes: [[col('type'), 'type'], [fn('COUNT', col('id')), 'count']],
        where,
        group: [col('type')],
        order: [[fn('COUNT', col('id')), 'DESC']],
      });

      const total = rows.reduce((s: number, r: any) => s + Number(r.get('count')), 0);
      const out = rows.map((r: any) => ({ type: r.get('type') || 'other', count: Number(r.get('count')), pct: total ? Number(r.get('count')) / total : 0 }));
      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Recent reports (by date)
  app.get('/reports/recent', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const dateQ = String(req.query.date || '').trim();
      const limit = Number(req.query.limit || 10);
      const { Op } = require('sequelize');

      let where: any = {};
      if (dateQ && dateQ.length >= 10) {
        const parts = dateQ.split('-');
        if (parts.length === 3) {
          const sd = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0));
          const ed = new Date(sd.getTime());
          ed.setUTCDate(ed.getUTCDate() + 1);
          where.createdAt = { [Op.gte]: sd, [Op.lt]: ed };
        }
      }
      if (tenantId) where.tenantId = tenantId;

      const rows = await req.database.report.findAll({ where, order: [['createdAt', 'DESC']], limit, include: [{ model: req.database.station, as: 'station' }] });
      const out = rows.map((r: any) => ({ id: r.id, title: r.title, site: r.station ? r.station.name : null, time: r.createdAt, author: r.officerName || r.officer || null }));
      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Reports by site (ranking)
  app.get('/reports/by-site', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const startQ = String(req.query.start || '').trim();
      const endQ = String(req.query.end || '').trim();
      const limit = Number(req.query.limit || 10);
      let start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (startQ && startQ.length >= 10) {
        const p = startQ.split('-');
        if (p.length === 3) start = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0));
      }
      let end = endQ && endQ.length >= 10 ? new Date(Date.UTC(Number(endQ.split('-')[0]), Number(endQ.split('-')[1]) - 1, Number(endQ.split('-')[2]), 0, 0, 0)) : new Date(start.getTime());
      if (end.getTime() === start.getTime()) end.setUTCDate(end.getUTCDate() + 1);

      const { fn, col, Op } = require('sequelize');
      const where = { createdAt: { [Op.gte]: start, [Op.lt]: end }, ...(tenantId ? { tenantId } : {}) };

      const rows = await req.database.report.findAll({
        attributes: [[col('stationId'), 'stationId'], [fn('COUNT', col('id')), 'count']],
        where,
        include: [{ model: req.database.station, as: 'station', attributes: ['id', 'name'] }],
        group: [col('stationId'), col('station.id')],
        order: [[fn('COUNT', col('id')), 'DESC']],
        limit,
      });

      const out = rows.map((r: any) => ({ site: r.station ? r.station.name : null, count: Number(r.get('count')) }));
      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Formats most used (fallback: static percentages)
  app.get('/reports/formats', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      // The report model doesn't currently track export formats; return sample distribution
      const out = [
        { format: 'PDF', pct: 0.56 },
        { format: 'Excel', pct: 0.28 },
        { format: 'CSV', pct: 0.10 },
        { format: 'Otros', pct: 0.06 },
      ];
      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Generate report (export) - enqueues or returns a generated report link (placeholder)
  app.post('/reports/generate', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportCreate);
      // Expect body: { start, end, format, templateId }
      const body = req.body || {};
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      const payload = {
        type: body.format || 'export',
        params: body,
        tenantId,
        createdById: req.currentUser ? req.currentUser.id : null,
      };

      const job = await db.reportJob.create(payload);
      // In a full implementation we'd enqueue the job for processing; return job record
      return ApiResponseHandler.success(req, res, job);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Schedule a recurring report (placeholder)
  app.post('/reports/schedule', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportCreate);
      const body = req.body || {};
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      const record = await db.reportSchedule.create({
        name: body.name || 'Scheduled Report',
        cron: body.cron || null,
        params: body.params || body,
        tenantId,
        createdById: req.currentUser ? req.currentUser.id : null,
      });
      return ApiResponseHandler.success(req, res, record);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Templates for export
  app.get('/reports/templates', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      // include system templates (tenantId null) and tenant templates
      const where: any = {};
      if (tenantId) where.tenantId = [null, tenantId];
      const rows = await db.reportTemplate.findAll({ where, order: [['isSystem', 'DESC'], ['name', 'ASC']] });
      return ApiResponseHandler.success(req, res, rows);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Favorites (user-scoped) - placeholder endpoints
  app.get('/reports/favorites', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      const where: any = {};
      if (tenantId) where.tenantId = tenantId;
      if (req.currentUser && req.currentUser.id) where.createdById = req.currentUser.id;
      const rows = await db.reportFavorite.findAll({ where, order: [['createdAt', 'DESC']] });
      return ApiResponseHandler.success(req, res, rows);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  app.post('/reports/favorites', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.reportCreate);
      const body = req.body || {};
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      const rec = await db.reportFavorite.create({
        name: body.name || null,
        params: body.params || body,
        tenantId,
        createdById: req.currentUser ? req.currentUser.id : null,
      });
      return ApiResponseHandler.success(req, res, rec);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Config endpoints for report settings
  app.get('/reports/config', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      const cfg = await db.reportConfig.findOne({ where: { ...(tenantId ? { tenantId } : {}) } });
      if (cfg) return ApiResponseHandler.success(req, res, cfg);
      return ApiResponseHandler.success(req, res, { defaultFormat: 'PDF', availableFormats: ['PDF', 'Excel', 'CSV'] });
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  app.put('/reports/config', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const body = req.body || {};
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const db = req.database;
      let cfg = await db.reportConfig.findOne({ where: { ...(tenantId ? { tenantId } : {}) } });
      if (!cfg) {
        cfg = await db.reportConfig.create({ defaultFormat: body.defaultFormat || null, options: body.options || null, tenantId, createdById: req.currentUser ? req.currentUser.id : null });
      } else {
        await cfg.update({ defaultFormat: body.defaultFormat || cfg.defaultFormat, options: body.options || cfg.options });
      }
      return ApiResponseHandler.success(req, res, cfg);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });
};
