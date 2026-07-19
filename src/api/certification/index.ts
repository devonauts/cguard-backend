export default (app) => {
  app.post(
    `/tenant/:tenantId/certification`,
    require('./certificationCreate').default,
  );
  app.put(
    `/tenant/:tenantId/certification/:id`,
    require('./certificationUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/certification`,
    require('./certificationDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/certification`,
    require('./certificationList').default,
  );
};
