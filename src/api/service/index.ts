export default (app) => {
  app.post(
    `/tenant/:tenantId/service`,
    require('./serviceCreate').default,
  );
  app.put(
    `/tenant/:tenantId/service/:id`,
    require('./serviceUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/service`,
    require('./serviceDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/service`,
    require('./serviceList').default,
  );
};
