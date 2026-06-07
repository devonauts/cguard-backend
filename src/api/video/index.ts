// Video surveillance API routes.
// Tenant-scoped routes live under /tenant/:tenantId/video/...
// The clip-share viewer route is PUBLIC (looked up by token, no tenant).
export default (app) => {
  // ---- Devices ----
  app.get('/tenant/:tenantId/video/devices', require('./deviceList').default);
  app.post('/tenant/:tenantId/video/device', require('./deviceCreate').default);
  app.get('/tenant/:tenantId/video/device/:id', require('./deviceGet').default);
  app.put('/tenant/:tenantId/video/device/:id', require('./deviceUpdate').default);
  app.delete('/tenant/:tenantId/video/device/:id', require('./deviceDelete').default);
  app.post('/tenant/:tenantId/video/device/:id/test', require('./deviceTest').default);
  app.post('/tenant/:tenantId/video/device/:id/cameras', require('./deviceCameras').default);

  // ---- Cameras ----
  app.get('/tenant/:tenantId/video/cameras', require('./cameraList').default);
  app.get('/tenant/:tenantId/video/camera/:id', require('./cameraGet').default);
  app.put('/tenant/:tenantId/video/camera/:id', require('./cameraUpdate').default);
  app.get('/tenant/:tenantId/video/camera/:id/stream', require('./cameraStream').default);

  // ---- Events ----
  app.get('/tenant/:tenantId/video/events', require('./eventList').default);
  app.post('/tenant/:tenantId/video/event', require('./eventCreate').default);
  app.patch('/tenant/:tenantId/video/event/:id', require('./eventUpdate').default);
  app.post('/tenant/:tenantId/video/event/:id/incident', require('./eventIncident').default);

  // ---- Clips ----
  app.get('/tenant/:tenantId/video/clips', require('./clipList').default);
  app.post('/tenant/:tenantId/video/clip', require('./clipCreate').default);
  app.delete('/tenant/:tenantId/video/clip/:id', require('./clipDelete').default);
  app.post('/tenant/:tenantId/video/clip/:id/share', require('./clipShare').default);
  app.post('/tenant/:tenantId/video/clip/:id/incident', require('./clipIncident').default);

  // ---- Public clip share viewer (no tenant, no auth) ----
  app.get('/video/clip/shared/:token', require('./clipShared').default);

  // ---- Dispatch ----
  app.post('/tenant/:tenantId/video/dispatch', require('./dispatch').default);
};
