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
