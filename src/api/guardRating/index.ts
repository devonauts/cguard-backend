export default (app) => {
  // CRM read of customer-generated guard ratings, scoped to the tenant.
  // Gated by securityGuardRead (all staff roles have it).
  // NOTE: register /summary BEFORE the base route so the literal path wins.
  app.get(
    `/tenant/:tenantId/guard-ratings/summary`,
    require('./guardRatingSummary').default,
  );
  app.get(
    `/tenant/:tenantId/guard-ratings`,
    require('./guardRatingList').default,
  );
};
