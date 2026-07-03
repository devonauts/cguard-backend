/**
 * Supervisor mobile-app API ("me" endpoints).
 *
 * All routes are tenant-scoped (/tenant/:tenantId/...) and gated with the
 * `supervisorMe` permission (admin, operationsManager, securitySupervisor).
 * "me" = req.currentUser; a supervisor manages their own shift + the route runs
 * of routes assigned to them (route.assignedGuard === currentUser.id).
 */
import { getClock, clockIn, clockOut } from './clock';
import { getStations } from './stations';
import { getStationsList } from './stationsList';
import { getGuards } from './guards';
import { getGuardDetail } from './guardDetail';
import {
  getRoutesToday,
  getRouteDetail,
  startRoute,
  checkStop,
  finishRoute,
} from './routes';

export default (app) => {
  // Own shift (clock in/out).
  app.get('/tenant/:tenantId/supervisor/me/clock', getClock);
  app.post('/tenant/:tenantId/supervisor/me/clock-in', clockIn);
  app.post('/tenant/:tenantId/supervisor/me/clock-out', clockOut);

  // Station monitor for the dashboard map (pins + status cards).
  app.get('/tenant/:tenantId/supervisor/me/stations', getStations);

  // Rich station roster for the Stations list screen.
  app.get('/tenant/:tenantId/supervisor/me/stations/list', getStationsList);

  // Guard roster + live telemetry for the Guards screen.
  app.get('/tenant/:tenantId/supervisor/me/guards', getGuards);

  // Full detail for one guard (profile + patrol + activity).
  app.get('/tenant/:tenantId/supervisor/me/guards/:guardId', getGuardDetail);

  // Assigned route runs for today.
  app.get('/tenant/:tenantId/supervisor/me/routes/today', getRoutesToday);
  app.get('/tenant/:tenantId/supervisor/me/routes/:routeId', getRouteDetail);
  app.post('/tenant/:tenantId/supervisor/me/routes/:routeId/start', startRoute);
  app.post(
    '/tenant/:tenantId/supervisor/me/routes/:routeId/stops/:pointId/check',
    checkStop,
  );
  app.post('/tenant/:tenantId/supervisor/me/routes/:routeId/finish', finishRoute);
};
