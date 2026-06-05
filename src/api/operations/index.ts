import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';

export default (app) => {
    // List of upcoming services
    app.get('/operations/upcoming-services', async (req, res) => {
      try {
        const tenantId = req.currentTenant ? req.currentTenant.id : null;
        const { Op } = require('sequelize');
        const now = new Date();
        const where = tenantId ? { tenantId, startDate: { [Op.gte]: now } } : { startDate: { [Op.gte]: now } };
        const services = await req.database.station.findAll({ where, order: [['startDate', 'ASC']], limit: 20 });
        // Map fields to include title, type, startTime/date
        const out = services.map((s: any) => ({
          id: s.id,
          title: s.stationName || s.name || 'Servicio próximo',
          type: s.type || '',
          startTime: s.startDate || s.date || null,
          location: s.location || s.address || null,
        }));
        return ApiResponseHandler.success(req, res, out);
      } catch (err) {
        return ApiResponseHandler.error(req, res, err);
      }
    });
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

      // Upcoming services count
      let upcomingServicesCount = 0;
      try {
        const now = new Date();
        const futureWhere = tenantId ? { tenantId, startDate: { [require('sequelize').Op.gte]: now } } : { startDate: { [require('sequelize').Op.gte]: now } };
        upcomingServicesCount = await db.station.count({ where: futureWhere });
      } catch (_) { upcomingServicesCount = 0; }

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
        { id: 'upcoming_services', title: 'Próximos servicios', value: String(upcomingServicesCount), trend: null },
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

      // Use the actual model attribute names in this codebase
      const stations = await req.database.station.findAll({ where: whereTenant, attributes: ['id', 'stationName', 'latitud', 'longitud'], limit: 500 });
      // Security guard model doesn't store latitude/longitude fields directly here; fetch id/full name
      const guards = await req.database.securityGuard.findAll({ where: whereTenant, attributes: ['id', 'fullName'], limit: 500 });
      // Attempt to get latest known position per guard from tagScan.scannedData if available
      const recentScans = await req.database.tagScan.findAll({ where: { ...(tenantId ? { tenantId } : {}), securityGuardId: { [Op.ne]: null }, scannedAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }, order: [['scannedAt', 'DESC']], limit: 1000 });
      const guardPositions: any = {};
      recentScans.forEach((s: any) => {
        const gid = s.securityGuardId;
        if (!gid) return;
        if (guardPositions[gid]) return; // keep the most recent
        const sd = s.scannedData || {};
        const lat = sd.latitude ?? sd.lat ?? null;
        const lng = sd.longitude ?? sd.lng ?? sd.long ?? null;
        if (lat != null && lng != null) guardPositions[gid] = { latitude: lat, longitude: lng, time: s.scannedAt };
      });
      // Incidents in this schema may not have latitude/longitude fields; fetch available attributes
      const incidents = await req.database.incident.findAll({ where: { ...(tenantId ? { tenantId } : {}), createdAt: { [Op.gte]: new Date(Date.now() - 24 * 3600 * 1000) } }, attributes: ['id', 'title', 'createdAt'], limit: 200 });

      const out: any[] = [];
      stations.forEach((s: any) => {
        const lat = s.latitud ?? null;
        const lng = s.longitud ?? null;
        if (lat != null && lng != null) out.push({ id: `station-${s.id}`, type: 'station', title: s.stationName || 'Estación', latitude: lat, longitude: lng });
      });
      // Guards: use latest tagScan position where available
      guards.forEach((g: any) => {
        const pos = guardPositions[g.id];
        if (pos) out.push({ id: `guard-${g.id}`, type: 'guard', title: g.fullName || 'Guardia', latitude: pos.latitude, longitude: pos.longitude, time: pos.time });
      });
      incidents.forEach((i: any) => {
        // incidents table in this schema doesn't include lat/long columns; skip coordinate mapping
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
