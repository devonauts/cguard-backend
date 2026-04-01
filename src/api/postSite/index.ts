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

  app.post(
    `/tenant/:tenantId/post-site/:id/assign-guard`,
    require('./postSiteAssignGuard').default,
  );

  app.delete(
    `/tenant/:tenantId/post-site/:id/guards/:assignmentId`,
    require('./postSiteRemoveAssignment').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/:id/guards`,
    require('./postSiteAssignedGuards').default,
  );

  // Backwards-compatible aliases: some frontends call these older paths.
  app.get(
    `/tenant/:tenantId/post-site/:id/assigned-guards`,
    require('./postSiteAssignedGuards').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/:id/security-guards`,
    require('./postSiteAssignedGuards').default,
  );

  // Precise postSite + station scoped assigned guards
  app.get(
    `/tenant/:tenantId/post-site/:id/station/:stationId/assigned-guards`,
    require('./postSiteStationAssignedGuards').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/:id/stations`,
    require('./postSiteStations').default,
  );

  app.get(
    `/tenant/:tenantId/post-site/:id/tasks`,
    require('./postSiteTasks').default,
  );

  // Overview counters for a post site (assigned guards, onsite, tours/tasks/incidents last 7 days, hours logged)
  app.get(
    `/tenant/:tenantId/post-site/:id/overview`,
    require('./postSiteOverview').default,
  );

  // Post site contacts (list by postSiteId)
  app.get(
    `/tenant/:tenantId/post-site/:id/contacts`,
    require('./postSiteContacts').default,
  );

  // Post site notes CRUD
  app.get(
    `/tenant/:tenantId/post-site/:id/notes`,
    require('./postSiteNotes').default,
  );
  app.post(
    `/tenant/:tenantId/post-site/:id/notes`,
    require('./postSiteNoteCreate').default,
  );
  app.put(
    `/tenant/:tenantId/post-site/:id/notes/:noteId`,
    require('./postSiteNoteUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/post-site/:id/notes/:noteId`,
    require('./postSiteNoteDestroy').default,
  );
};
