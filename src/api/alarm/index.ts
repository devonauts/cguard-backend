// Alarm monitoring (central station) API routes.
// Tenant-scoped routes live under /tenant/:tenantId/alarm/...
// The ingest + manual endpoints accept signals from clients' panels / receivers.
export default (app) => {
  // ---- Panels ----
  app.get('/tenant/:tenantId/alarm/panels', require('./panelList').default);
  app.post('/tenant/:tenantId/alarm/panel', require('./panelCreate').default);
  app.get('/tenant/:tenantId/alarm/panel/:id', require('./panelGet').default);
  app.put('/tenant/:tenantId/alarm/panel/:id', require('./panelUpdate').default);
  app.delete('/tenant/:tenantId/alarm/panel/:id', require('./panelDelete').default);

  // ---- Zones ----
  app.get('/tenant/:tenantId/alarm/panel/:id/zones', require('./zoneList').default);
  app.post('/tenant/:tenantId/alarm/panel/:id/zone', require('./zoneCreate').default);
  app.put('/tenant/:tenantId/alarm/zone/:id', require('./zoneUpdate').default);
  app.delete('/tenant/:tenantId/alarm/zone/:id', require('./zoneDelete').default);

  // ---- Contacts ----
  app.get('/tenant/:tenantId/alarm/panel/:id/contacts', require('./contactList').default);
  app.post('/tenant/:tenantId/alarm/panel/:id/contact', require('./contactCreate').default);
  app.put('/tenant/:tenantId/alarm/contact/:id', require('./contactUpdate').default);
  app.delete('/tenant/:tenantId/alarm/contact/:id', require('./contactDelete').default);

  // ---- Action plans ----
  app.get('/tenant/:tenantId/alarm/action-plans', require('./planList').default);
  app.post('/tenant/:tenantId/alarm/action-plan', require('./planCreate').default);
  app.put('/tenant/:tenantId/alarm/action-plan/:id', require('./planUpdate').default);
  app.delete('/tenant/:tenantId/alarm/action-plan/:id', require('./planDelete').default);

  // ---- Open/Close schedules ----
  app.get('/tenant/:tenantId/alarm/panel/:id/schedules', require('./scheduleList').default);
  app.post('/tenant/:tenantId/alarm/panel/:id/schedule', require('./scheduleCreate').default);
  app.delete('/tenant/:tenantId/alarm/schedule/:id', require('./scheduleDelete').default);

  // ---- Signals & events (read-only) ----
  app.get('/tenant/:tenantId/alarm/signals', require('./signalList').default);
  app.get('/tenant/:tenantId/alarm/events', require('./eventList').default);

  // ---- Cases ----
  app.get('/tenant/:tenantId/alarm/cases', require('./caseList').default);
  app.get('/tenant/:tenantId/alarm/case/:id', require('./caseGet').default);
  app.post('/tenant/:tenantId/alarm/case/:id/acknowledge', require('./caseAcknowledge').default);
  app.post('/tenant/:tenantId/alarm/case/:id/dispatch', require('./caseDispatch').default);
  app.post('/tenant/:tenantId/alarm/case/:id/resolve', require('./caseResolve').default);
  app.post('/tenant/:tenantId/alarm/case/:id/close', require('./caseClose').default);
  app.post('/tenant/:tenantId/alarm/case/:id/incident', require('./caseIncident').default);
  app.post('/tenant/:tenantId/alarm/case/:id/note', require('./caseNote').default);
  app.get('/tenant/:tenantId/alarm/case/:id/action-plan', require('./caseActionPlan').default);
  app.post('/tenant/:tenantId/alarm/case/:id/step', require('./caseStep').default);

  // ---- Ingest (webhook + manual) ----
  app.post('/tenant/:tenantId/alarm/ingest', require('./ingestWebhook').default);
  app.post('/tenant/:tenantId/alarm/manual', require('./ingestManual').default);
};
