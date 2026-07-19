/**
 * @deprecated Superseded by the siteTour system (site-tour / site-tour/:id/tag /
 * site-tour/tag-scan). Kept for backward compatibility until legacy data is migrated.
 * Do not build new features on these endpoints.
 */
export default (app) => {
  app.post(
    `/tenant/:tenantId/patrol`,
    require('./patrolCreate').default,
  );
  app.put(
    `/tenant/:tenantId/patrol/:id`,
    require('./patrolUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/patrol`,
    require('./patrolDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/patrol`,
    require('./patrolList').default,
  );
  app.get(
    `/tenant/:tenantId/patrol/:id`,
    require('./patrolFind').default,
  );
};
