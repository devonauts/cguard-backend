// IP radio (RoIP/SIP gateway) registry — tenant-scoped CRUD + a test action.
// Routes live under /tenant/:tenantId/radio-device[s].
export default (app) => {
  app.get('/tenant/:tenantId/radio-devices', require('./list').default);
  app.post('/tenant/:tenantId/radio-device', require('./create').default);
  app.get('/tenant/:tenantId/radio-device/:id', require('./get').default);
  app.put('/tenant/:tenantId/radio-device/:id', require('./update').default);
  app.delete('/tenant/:tenantId/radio-device/:id', require('./destroy').default);
  app.post('/tenant/:tenantId/radio-device/:id/test', require('./test').default);
};
