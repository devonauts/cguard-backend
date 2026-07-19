export default (app) => {
  app.post(
    `/tenant/:tenantId/station`,
    require('./stationCreate').default,
  );
  app.put(
    `/tenant/:tenantId/station/:id`,
    require('./stationUpdate').default,
  );
  // Set exact coordinates only (map pin placement)
  app.patch(
    `/tenant/:tenantId/station/:id/location`,
    require('./stationLocation').default,
  );
  app.delete(
    `/tenant/:tenantId/station`,
    require('./stationDestroy').default,
  );
  // Support delete by id path for frontend callers that send /station/:id
  app.delete(
    `/tenant/:tenantId/station/:id`,
    require('./stationDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/station/autocomplete`,
    require('./stationAutocomplete').default,
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


  app.delete(
    `/tenant/:tenantId/stations`,
    require('./stationDestroy').default,
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


  app.get(
    `/tenant/:tenantId/stations/:id/guards`,
    require('../postSite/postSiteAssignedGuards').default,
  );

  // NOTE: a former block here re-registered the same /stations paths as
  // businessInfo aliases. It was DEAD — the real /stations station handlers above
  // are registered first, so Express always matched those and the aliases never
  // ran. Removed to avoid the misleading duplicate (no runtime change).
};
