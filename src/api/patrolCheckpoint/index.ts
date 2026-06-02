/**
 * @deprecated Superseded by siteTourTag (site-tour/:id/tag). Kept for backward
 * compatibility until legacy data is migrated. Do not build new features here.
 */
export default (app) => {
  app.post(
    `/tenant/:tenantId/patrol-checkpoint`,
    require('./patrolCheckpointCreate').default,
  );
  app.put(
    `/tenant/:tenantId/patrol-checkpoint/:id`,
    require('./patrolCheckpointUpdate').default,
  );
  app.post(
    `/tenant/:tenantId/patrol-checkpoint/import`,
    require('./patrolCheckpointImport').default,
  );
  app.delete(
    `/tenant/:tenantId/patrol-checkpoint`,
    require('./patrolCheckpointDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/patrol-checkpoint/autocomplete`,
    require('./patrolCheckpointAutocomplete').default,
  );
  app.get(
    `/tenant/:tenantId/patrol-checkpoint`,
    require('./patrolCheckpointList').default,
  );
  app.get(
    `/tenant/:tenantId/patrol-checkpoint/:id`,
    require('./patrolCheckpointFind').default,
  );
};
