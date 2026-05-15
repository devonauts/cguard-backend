export default (app) => {
  /**
   * GET /api/customer/me/account
   *
   * Returns the full account snapshot (clientAccount + postSites + guards +
   * incidents + activeShifts + inventory) for the authenticated customer.
   *
   * Auth: Bearer token issued by POST /auth/sign-in-customer
   * The clientAccountId embedded in the JWT is used to scope all queries.
   */
  app.get(
    '/customer/me/account',
    require('./customerAccountMe').default,
  );

  /**
   * GET /api/customer/post-site/:postSiteId/active-status
   *
   * Returns stations + on-duty guards + next shift info for a specific post site.
   * The post site must belong to the authenticated customer's clientAccount.
   */
  app.get(
    '/customer/post-site/:postSiteId/active-status',
    require('./customerPostSiteActiveStatus').default,
  );
};
