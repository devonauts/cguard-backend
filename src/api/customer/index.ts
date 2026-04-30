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
};
