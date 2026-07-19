export default (app) => {
  app.post(
    `/tenant/:tenantId/notification`,
    require('./notificationCreate').default,
  );
  app.delete(
    `/tenant/:tenantId/notification`,
    require('./notificationDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/notification`,
    require('./notificationList').default,
  );
};
