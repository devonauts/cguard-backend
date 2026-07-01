export default (app) => {
  app.get(`/tenant/:tenantId/passdown`, require('./passdownList').default);
  app.get(`/tenant/:tenantId/passdown/:id`, require('./passdownFind').default);
};
