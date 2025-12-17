export default (app) => {
  // Legacy compatibility routes for frontend that still call /post-site
  app.post(
    `/tenant/:tenantId/post-site`,
    require('../businessInfo/businessInfoCreate').default,
  );

  app.put(
    `/tenant/:tenantId/post-site/:id`,
    require('../businessInfo/businessInfoUpdate').default,
  );

  app.post(
    `/tenant/:tenantId/post-site/import`,
    require('../businessInfo/businessInfoFileImport').default,
  );

  app.delete(
    `/tenant/:tenantId/post-site`,
    require('../businessInfo/businessInfoDestroy').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/autocomplete`,
    require('../businessInfo/businessInfoAutocomplete').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/export`,
    require('../businessInfo/businessInfoExport').default,
  );

  app.get(
    `/tenant/:tenantId/post-site`,
    require('../businessInfo/businessInfoList').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/:id`,
    require('../businessInfo/businessInfoFind').default,
  );
};
