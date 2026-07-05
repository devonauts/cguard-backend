/**
 * Supervisor mobile-app API ("me" endpoints).
 *
 * All routes are tenant-scoped (/tenant/:tenantId/...) and gated with the
 * `supervisorMe` permission (admin, operationsManager, securitySupervisor).
 * "me" = req.currentUser; a supervisor manages their own shift + the route runs
 * of routes assigned to them (route.assignedGuard === currentUser.id).
 */
import { getClock, clockIn, clockOut } from './clock';
import { getSchedule } from './schedule';
import { getStations } from './stations';
import { getStationsList } from './stationsList';
import { getStationDetail } from './stationDetail';
import { createStationTask } from './stationTaskCreate';
import { createInspection, listInspections } from './stationInspection';
import { getIncidents } from './incidents';
import { getVisitors } from './visitors';
import { getVisitorDetail, checkoutVisitor } from './visitorDetail';
import { getRadioChannels } from './radioChannels';
import { getEmergency } from './emergency';
import { getReports } from './reports';
import { supMessageList, supMessageCreate, supMessageGet, supMessageThread, supMessageReply, supMessageMarkRead, supMessageDelete } from './messages';
import { getIncidentDetail, addIncidentNote, setIncidentStatus, assignIncident, escalateIncident, respondDispatch } from './incidentDetail';
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
  app.get('/tenant/:tenantId/supervisor/me/schedule', getSchedule);

  // Station monitor for the dashboard map (pins + status cards).
  app.get('/tenant/:tenantId/supervisor/me/stations', getStations);

  // Rich station roster for the Stations list screen.
  app.get('/tenant/:tenantId/supervisor/me/stations/list', getStationsList);

  // Full detail for one station (must come AFTER /stations/list so the literal
  // wins over the :stationId param).
  app.get('/tenant/:tenantId/supervisor/me/stations/:stationId', getStationDetail);

  // Create a task for a station (Station Details → Add Task).
  app.post('/tenant/:tenantId/supervisor/me/stations/:stationId/tasks', createStationTask);

  // Station inspections (Station Details → Start Inspection).
  app.post('/tenant/:tenantId/supervisor/me/stations/:stationId/inspection', createInspection);
  app.get('/tenant/:tenantId/supervisor/me/stations/:stationId/inspections', listInspections);

  // Incidents list (image-forward) for the Incidents screen.
  app.get('/tenant/:tenantId/supervisor/me/incidents', getIncidents);

  // Incident detail + supervisor actions.
  app.get('/tenant/:tenantId/supervisor/me/incidents/:incidentId', getIncidentDetail);
  app.post('/tenant/:tenantId/supervisor/me/incidents/:incidentId/note', addIncidentNote);
  app.post('/tenant/:tenantId/supervisor/me/incidents/:incidentId/status', setIncidentStatus);
  app.post('/tenant/:tenantId/supervisor/me/incidents/:incidentId/assign', assignIncident);
  app.post('/tenant/:tenantId/supervisor/me/incidents/:incidentId/escalate', escalateIncident);
  app.post('/tenant/:tenantId/supervisor/me/incidents/:incidentId/respond', respondDispatch);

  // Visitors feed for the Visitors screen.
  app.get('/tenant/:tenantId/supervisor/me/visitors', getVisitors);
  app.get('/tenant/:tenantId/supervisor/me/visitors/:visitorId', getVisitorDetail);
  app.post('/tenant/:tenantId/supervisor/me/visitors/:visitorId/checkout', checkoutVisitor);

  // Radio channels (live PTT presence) for the Radio screen.
  app.get('/tenant/:tenantId/supervisor/me/radio/channels', getRadioChannels);

  // Emergency contacts for the SOS screen.
  app.get('/tenant/:tenantId/supervisor/me/emergency', getEmergency);

  // Reports/analytics overview.
  app.get('/tenant/:tenantId/supervisor/me/reports', getReports);

  // Private supervisor messaging (scoped to the user; encrypted; per-user delete).
  app.get('/tenant/:tenantId/supervisor/me/messages', supMessageList);
  app.post('/tenant/:tenantId/supervisor/me/messages', supMessageCreate);
  app.get('/tenant/:tenantId/supervisor/me/messages/:conversationId/messages', supMessageThread);
  app.post('/tenant/:tenantId/supervisor/me/messages/:conversationId/read', supMessageMarkRead);
  app.get('/tenant/:tenantId/supervisor/me/messages/:conversationId', supMessageGet);
  app.post('/tenant/:tenantId/supervisor/me/messages/:conversationId', supMessageReply);
  app.delete('/tenant/:tenantId/supervisor/me/messages/:conversationId', supMessageDelete);

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
