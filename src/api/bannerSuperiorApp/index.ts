export default (app) => {
  app.post(
    `/tenant/:tenantId/banner-superior-app`,
    require('./bannerSuperiorAppCreate').default,
  );
  app.put(
    `/tenant/:tenantId/banner-superior-app/:id`,
    require('./bannerSuperiorAppUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/banner-superior-app`,
    require('./bannerSuperiorAppDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/banner-superior-app`,
    require('./bannerSuperiorAppList').default,
  );
};
