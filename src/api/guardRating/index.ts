export default (app) => {
  // CRM read of customer-generated guard ratings, scoped to the tenant.
  // Gated by securityGuardRead (all staff roles have it).
  app.get(
    `/tenant/:tenantId/guard-ratings`,
    require('./guardRatingList').default,
  );
};
