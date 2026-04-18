export default (app) => {
  app.post(`/tenant/:tenantId/route`, require('./routeCreate').default);
  app.put(`/tenant/:tenantId/route/:id`, require('./routeUpdate').default);
  app.post(`/tenant/:tenantId/route/import`, require('./routeCreate').default);
  app.delete(`/tenant/:tenantId/route`, require('./routeDestroy').default);
  app.get(`/tenant/:tenantId/route/autocomplete`, require('./routeAutocomplete').default);
  app.get(`/tenant/:tenantId/route`, require('./routeList').default);
  app.get(`/tenant/:tenantId/route/:id`, require('./routeFind').default);
};
