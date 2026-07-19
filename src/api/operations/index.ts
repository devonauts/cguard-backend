import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';
import Error401 from '../../errors/Error401';
import Error403 from '../../errors/Error403';

// These routes have no :tenantId param, so tenantMiddleware never runs and
// authMiddleware lets tokenless requests through. Fail CLOSED here: an
// unauthenticated request (or a token without a tenant claim) must never fall
// back to an unscoped cross-tenant query.
export function requireTenantId(req, res): string | null {
  if (!req.currentUser) {
    ApiResponseHandler.error(req, res, new Error401());
    return null;
  }
  const tenantId = req.currentTenant && req.currentTenant.id;
  if (!tenantId) {
    ApiResponseHandler.error(req, res, new Error403());
    return null;
  }
  return tenantId;
}

export default (app) => {
    // Operations analytics dashboard (tenant-scoped, permission-gated).
    app.get('/tenant/:tenantId/operations/analytics', require('./analytics').default);

    // List of upcoming services
    app.get('/operations/upcoming-services', async (req, res) => {
      try {
        const tenantId = requireTenantId(req, res);
        if (!tenantId) return;
        const { Op } = require('sequelize');
        const now = new Date();
        const where = { tenantId, startDate: { [Op.gte]: now } };
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
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;
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
        stationsCount = await db.station.count({ where: { tenantId } });
      } catch (_) { stationsCount = 0; }

      // Upcoming services count
      let upcomingServicesCount = 0;
      try {
        const now = new Date();
        upcomingServicesCount = await db.station.count({ where: { tenantId, startDate: { [require('sequelize').Op.gte]: now } } });
      } catch (_) { upcomingServicesCount = 0; }

      // Guards on duty
      let guardsOnDuty = 0;
      // Derived from the SINGLE SOURCE OF TRUTH (an open guardShift = clocked in,
      // not punched out), not the denormalized isOnDuty flag.
      try {
        const [rows]: any = await db.sequelize.query(
          `SELECT COUNT(DISTINCT gs.guardNameId) AS n
             FROM guardShifts gs
            WHERE gs.deletedAt IS NULL AND gs.punchOutTime IS NULL
              AND gs.tenantId = :tenantId`,
          { replacements: { tenantId } },
        );
        guardsOnDuty = Number(rows?.[0]?.n || 0);
      } catch (_) { guardsOnDuty = 0; }

      // Incidents today
      let incidentsToday = 0;
      try {
        const { Op } = require('sequelize');
        incidentsToday = await db.incident.count({ where: { tenantId, createdAt: { [Op.gte]: start, [Op.lt]: end } } });
      } catch (_) { incidentsToday = 0; }

      // Tag scans (rondas) today
      let scansToday = 0;
      try {
        const { Op } = require('sequelize');
        scansToday = await db.tagScan.count({ where: { tenantId, scannedAt: { [Op.gte]: start, [Op.lt]: end } } });
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
  // IMPORTANT: This endpoint is used by the Flutter map to show ALL operational markers
  app.get('/operations/activities', async (req, res) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;
      const dateStr = String(req.query.date || '').trim();
      const sinceStr = String(req.query.since || '').trim();
      const { Op } = require('sequelize');

      if (sinceStr) {
        const since = new Date(sinceStr);
        const where: any = { tenantId, createdAt: { [Op.gte]: since } };
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
      const whereDay: any = { tenantId, createdAt: { [Op.gte]: start, [Op.lt]: end } };

      // Get all stations with coordinates (for guard locations and patrol base)
      const stations = await req.database.station.findAll({
        where: { tenantId },
        attributes: ['id', 'latitud', 'longitud', 'stationName']
      });
      const stationMap: any = {};
      stations.forEach((s: any) => {
        stationMap[s.id] = { latitude: s.latitud, longitude: s.longitud, name: s.stationName };
      });

      // Get all security guards (on duty)
      const guards = await req.database.securityGuard.findAll({
        where: { tenantId },
        attributes: ['id', 'fullName', 'stationId']
      });

      // Get active guard shifts (on duty) FILTERED BY DATE
      const activeShifts = await req.database.guardShift.findAll({
        where: {
          punchOutTime: null, // Still clocked in
          createdAt: { [Op.gte]: start, [Op.lt]: end }, // ONLY for this date
          tenantId,
        },
        attributes: ['id', 'guardNameId', 'stationId']
      });

      // Aggregate all markers: guards on duty, reports, incidents, patrols, stations
      const items: any[] = [];

      // Add guards on duty with their station coordinates
      const guardOnDutyIds = new Set(activeShifts.map((s: any) => s.guardNameId));
      guards.forEach((g: any) => {
        if (guardOnDutyIds.has(g.id)) {
          const item: any = {
            id: `g-${g.id}`,
            time: new Date(),
            text: g.fullName || 'Guardia',
            officerName: g.fullName,
            type: 'guard',
            severity: 'low'
          };
          // Get station coordinates
          if (g.stationId && stationMap[g.stationId]) {
            item.latitude = stationMap[g.stationId].latitude;
            item.longitude = stationMap[g.stationId].longitude;
            item.locationName = stationMap[g.stationId].name;
          }
          items.push(item);
        }
      });

      // Add stations as patrol/ronda locations
      stations.forEach((s: any) => {
        if (s.latitud && s.longitud) {
          items.push({
            id: `st-${s.id}`,
            time: new Date(),
            text: s.stationName || 'Estación',
            type: 'patrol',
            latitude: s.latitud,
            longitude: s.longitud,
            locationName: s.stationName
          });
        }
      });

      // Add reports
      const reports = await req.database.report.findAll({ where: whereDay, order: [['createdAt', 'DESC']], limit: 50 });
      reports.forEach((r: any) => items.push({ id: `r-${r.id}`, time: r.createdAt, text: r.title || r.summary || r.type, officerName: r.officerName || r.officer, type: 'report', severity: r.severity || 'medium' }));

      // Add incidents with coordinates - get ALL incidents, not filtered by date
      // (the frontend will handle date filtering)
      const allIncidents = await req.database.incident.findAll({
        where: { tenantId },
        order: [['createdAt', 'DESC']],
        limit: 500
      });

      allIncidents.forEach((r: any) => {
        const item: any = {
          id: `i-${r.id}`,
          time: r.createdAt || r.updatedAt || new Date(),
          text: r.title || r.summary || r.type || 'Incidente',
          officerName: r.guardName || r.officer || 'Sistema',
          type: 'incident',
          severity: r.severity || 'high',
          location: r.location || null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt
        };

        // Look up coordinates from station if stationId is available
        const stationId = r.stationId || r.stationIncidents;
        if (stationId && stationMap[stationId]) {
          item.latitude = stationMap[stationId].latitude;
          item.longitude = stationMap[stationId].longitude;
          item.locationName = stationMap[stationId].name;
        }

        items.push(item);
      });

      // Add patrols (rondas)
      const patrols = await req.database.patrolLog.findAll({ where: { tenantId, createdAt: { [Op.gte]: start, [Op.lt]: end } }, order: [['createdAt', 'DESC']], limit: 50 });
      patrols.forEach((p: any) => items.push({ id: `p-${p.id}`, time: p.createdAt, text: p.note || p.summary || 'Patrol event', officerName: p.guardName || p.officer, type: 'patrol', severity: 'low' }));

      // sort by time desc and return
      items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      return ApiResponseHandler.success(req, res, items);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });

  // Markers for map: stations, guards (with last known pos), recent incidents
  app.get('/operations/markers', async (req, res) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;
      const { Op } = require('sequelize');
      const whereTenant = { tenantId };

      // Use the actual model attribute names in this codebase
      const stations = await req.database.station.findAll({ where: whereTenant, attributes: ['id', 'stationName', 'latitud', 'longitud'], limit: 500 });
      // Security guard model doesn't store latitude/longitude fields directly here; fetch id/full name
      const guards = await req.database.securityGuard.findAll({ where: whereTenant, attributes: ['id', 'fullName'], limit: 500 });
      // Attempt to get latest known position per guard from tagScan.scannedData if available
      const recentScans = await req.database.tagScan.findAll({ where: { tenantId, securityGuardId: { [Op.ne]: null }, scannedAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }, order: [['scannedAt', 'DESC']], limit: 1000 });
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
      const incidents = await req.database.incident.findAll({ where: { tenantId, createdAt: { [Op.gte]: new Date(Date.now() - 24 * 3600 * 1000) } }, attributes: ['id', 'title', 'createdAt'], limit: 200 });

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
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;
      const body = req.body || {};
      const title = body.title || 'SOS';
      const details = body.details || body.note || null;
      const siteId = body.siteId || null;

      const payload: any = { title, description: details, type: 'sos', status: 'open', ...(siteId ? { siteId } : {}), tenantId };
      const created = await req.database.incident.create(payload);
      return ApiResponseHandler.success(req, res, created);
    } catch (err) {
      return ApiResponseHandler.error(req, res, err);
    }
  });
};
