export default (app) => {
  app.post(
    `/tenant/:tenantId/station`,
    require('./stationCreate').default,
  );
  app.put(
    `/tenant/:tenantId/station/:id`,
    require('./stationUpdate').default,
  );
  app.post(
    `/tenant/:tenantId/station/import`,
    require('./stationImport').default,
  );
  app.delete(
    `/tenant/:tenantId/station`,
    require('./stationDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/station/autocomplete`,
    require('./stationAutocomplete').default,
  );
  app.get(
    `/tenant/:tenantId/station/export`,
    require('./stationExport').default,
  );
  app.get(
    `/tenant/:tenantId/station`,
    require('./stationList').default,
  );
  app.get(
    `/tenant/:tenantId/station/:id`,
    require('./stationFind').default,
  );

  // Plural aliases for frontend compatibility
  app.post(
    `/tenant/:tenantId/stations`,
    require('./stationCreate').default,
  );

  app.put(
    `/tenant/:tenantId/stations/:id`,
    require('./stationUpdate').default,
  );

  app.post(
    `/tenant/:tenantId/stations/import`,
    require('./stationImport').default,
  );

  app.delete(
    `/tenant/:tenantId/stations`,
    require('./stationDestroy').default,
  );

  app.get(
    `/tenant/:tenantId/stations/autocomplete`,
    require('./stationAutocomplete').default,
  );

  app.get(
    `/tenant/:tenantId/stations/export`,
    require('./stationExport').default,
  );

  app.get(
    `/tenant/:tenantId/stations`,
    require('./stationList').default,
  );

  app.get(
    `/tenant/:tenantId/stations/:id`,
    require('./stationFind').default,
  );

  // Guard assignment aliases (map to post-site handlers)
  app.post(
    `/tenant/:tenantId/stations/:id/assign-guard`,
    require('../postSite/postSiteAssignGuard').default,
  );

  app.delete(
    `/tenant/:tenantId/stations/:id/guards/:assignmentId`,
    require('../postSite/postSiteRemoveAssignment').default,
  );

  app.get(
    `/tenant/:tenantId/stations/:id/guards`,
    require('../postSite/postSiteAssignedGuards').default,
  );

  // Backwards-compatibility aliases to serve businessInfo (post-site) data
  // so frontend calling /stations receives businessInfo rows.
  app.post(
    `/tenant/:tenantId/stations`,
    require('../businessInfo/businessInfoCreate').default,
  );

  app.put(
    `/tenant/:tenantId/stations/:id`,
    require('../businessInfo/businessInfoUpdate').default,
  );

  app.post(
    `/tenant/:tenantId/stations/import`,
    require('../businessInfo/businessInfoFileImport').default,
  );

  app.delete(
    `/tenant/:tenantId/stations`,
    require('../businessInfo/businessInfoDestroy').default,
  );

  app.get(
    `/tenant/:tenantId/stations/autocomplete`,
    require('../businessInfo/businessInfoAutocomplete').default,
  );

  app.get(
    `/tenant/:tenantId/stations/export`,
    require('../businessInfo/businessInfoExport').default,
  );

  app.get(
    `/tenant/:tenantId/stations`,
    require('../businessInfo/businessInfoList').default,
  );

  app.get(
    `/tenant/:tenantId/stations/:id`,
    require('../businessInfo/businessInfoFind').default,
  );
};
