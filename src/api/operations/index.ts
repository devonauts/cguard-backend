import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default (app) => {
  // Returns a short list of KPIs for the frontend operations dashboard.
  app.get('/operations/kpis', async (req, res, next) => {
    try {
      // Compute daily KPIs from DB models for the current tenant
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      // date param optional (YYYY-MM-DD)
      const dateStr = String(req.query.date || '').trim();
      let start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (dateStr && dateStr.length >= 10) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const y = Number(parts[0]);
          const m = Number(parts[1]) - 1;
          const d = Number(parts[2]);
          start = new Date(Date.UTC(y, m, d, 0, 0, 0));
        }
      }
      const end = new Date(start.getTime());
      end.setUTCDate(end.getUTCDate() + 1);

      const db = req.database;

      // Stations count (Servicios activos)
      let stationsCount = 0;
      try {
        stationsCount = await db.station.count({ where: tenantId ? { tenantId } : undefined });
      } catch (_) { stationsCount = 0; }

      // Guards on duty
      let guardsOnDuty = 0;
      try {
        const where = tenantId ? { tenantId, isOnDuty: true } : { isOnDuty: true };
        guardsOnDuty = await db.securityGuard.count({ where });
      } catch (_) { guardsOnDuty = 0; }

      // Incidents today
      let incidentsToday = 0;
      try {
        const where: any = { createdAt: { $gte: start, $lt: end } };
        if (tenantId) where.tenantId = tenantId;
        // use Sequelize Op instead of $ operators
        const { Op } = require('sequelize');
        const whereOp: any = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
        if (tenantId) whereOp.tenantId = tenantId;
        incidentsToday = await db.incident.count({ where: whereOp });
      } catch (_) { incidentsToday = 0; }

      // Tag scans (rondas) today
      let scansToday = 0;
      try {
        const { Op } = require('sequelize');
        const whereOp: any = { scannedAt: { [Op.gte]: start, [Op.lt]: end } };
        if (tenantId) whereOp.tenantId = tenantId;
        scansToday = await db.tagScan.count({ where: whereOp });
      } catch (_) { scansToday = 0; }

      const out = [
        { id: 'stations', title: 'Servicios activos', value: String(stationsCount), trend: null },
        { id: 'guards', title: 'Guardias en servicio', value: String(guardsOnDuty), trend: null },
        { id: 'incidents', title: 'Incidentes hoy', value: String(incidentsToday), trend: null },
        { id: 'rondas', title: 'Rondas completadas', value: String(scansToday), trend: null },
      ];

      return ApiResponseHandler.success(req, res, out);
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });
  app.get('/operations/kpis/:id', require('./detail').default);

  // Activities feed: supports ?date=YYYY-MM-DD or ?since=ISO_TIMESTAMP
  app.get('/operations/activities', async (req, res) => {
    try {
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const dateStr = String(req.query.date || '').trim();
      const sinceStr = String(req.query.since || '').trim();
      const { Op } = require('sequelize');

      if (sinceStr) {
        const since = new Date(sinceStr);
        const where: any = { createdAt: { [Op.gte]: since } };
        if (tenantId) where.tenantId = tenantId;
        const rows = await req.database.report.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
        const out = rows.map((r: any) => ({ id: r.id, time: r.createdAt, text: r.title || r.summary || r.type, officerName: r.officerName || r.officer, type: r.type || 'report', severity: r.severity || 'medium' }));
        return ApiResponseHandler.success(req, res, out);
      }

      // date-based feed (day)
      let start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (dateStr && dateStr.length >= 10) {
        const parts = dateStr.split('-');
        if (parts.length === 3) start = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0));
      }
      const end = new Date(start.getTime());
      end.setUTCDate(end.getUTCDate() + 1);
      const whereDay: any = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
      if (tenantId) whereDay.tenantId = tenantId;

      // Aggregate recent activity from reports, incidents and patrol logs
      const reports = await req.database.report.findAll({ where: whereDay, order: [['createdAt', 'DESC']], limit: 50 });
      const incidents = await req.database.incident.findAll({ where: whereDay, order: [['createdAt', 'DESC']], limit: 50 });
      const patrols = await req.database.patrolLog.findAll({ where: { createdAt: { [Op.gte]: start, [Op.lt]: end }, ...(tenantId ? { tenantId } : {}) }, order: [['createdAt', 'DESC']], limit: 50 });

      const items: any[] = [];
      reports.forEach((r: any) => items.push({ id: `r-${r.id}`, time: r.createdAt, text: r.title || r.summary || r.type, officerName: r.officerName || r.officer, type: 'report', severity: r.severity || 'medium' }));
      incidents.forEach((r: any) => items.push({ id: `i-${r.id}`, time: r.createdAt, text: r.title || r.summary || r.type, officerName: r.guardName || r.officer, type: 'incident', severity: r.severity || 'high' }));
      patrols.forEach((p: any) => items.push({ id: `p-${p.id}`, time: p.createdAt, text: p.note || p.summary || 'Patrol event', officerName: p.guardName || p.officer, type: 'patrol', severity: 'low' }));

      // sort by time desc and return top 100
      items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      const out = items.slice(0, 100);
      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Markers for map: stations, guards (with last known pos), recent incidents
  app.get('/operations/markers', async (req, res) => {
    try {
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const { Op } = require('sequelize');
      const whereTenant = tenantId ? { tenantId } : {};

      const stations = await req.database.station.findAll({ where: whereTenant, attributes: ['id', 'name', 'latitude', 'longitude'], limit: 500 });
      const guards = await req.database.securityGuard.findAll({ where: whereTenant, attributes: ['id', 'firstName', 'lastName', 'lastLatitude', 'lastLongitude'], limit: 500 });
      const incidents = await req.database.incident.findAll({ where: { ...(tenantId ? { tenantId } : {}), createdAt: { [Op.gte]: new Date(Date.now() - 24 * 3600 * 1000) } }, attributes: ['id', 'title', 'latitude', 'longitude', 'createdAt'], limit: 200 });

      const out: any[] = [];
      stations.forEach((s: any) => {
        if (s.latitude != null && s.longitude != null) out.push({ id: `station-${s.id}`, type: 'station', title: s.name || 'Estación', latitude: s.latitude, longitude: s.longitude });
      });
      guards.forEach((g: any) => {
        const lat = g.lastLatitude ?? g.latitude ?? null;
        const lng = g.lastLongitude ?? g.longitude ?? null;
        if (lat != null && lng != null) out.push({ id: `guard-${g.id}`, type: 'guard', title: `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim(), latitude: lat, longitude: lng });
      });
      incidents.forEach((i: any) => {
        if (i.latitude != null && i.longitude != null) out.push({ id: `incident-${i.id}`, type: 'incident', title: i.title || 'Incidente', latitude: i.latitude, longitude: i.longitude, createdAt: i.createdAt });
      });

      return ApiResponseHandler.success(req, res, out);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // SOS endpoint: create an incident of type SOS
  app.post('/operations/sos', async (req, res) => {
    try {
      const tenantId = req.currentTenant ? req.currentTenant.id : null;
      const body = req.body || {};
      const title = body.title || 'SOS';
      const details = body.details || body.note || null;
      const siteId = body.siteId || null;

      const payload: any = { title, description: details, type: 'sos', status: 'open', ...(siteId ? { siteId } : {}), ...(tenantId ? { tenantId } : {}) };
      const created = await req.database.incident.create(payload);
      return ApiResponseHandler.success(req, res, created);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });
};
