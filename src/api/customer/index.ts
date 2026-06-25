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

  // Client-app messaging (scoped to the JWT's clientAccount). Client UI lives in
  // a separate project; these endpoints are the contract it connects to.
  app.get('/customer/messages', require('./customerMessages').customerMessagesList);
  // Client starts a NEW thread with the office (lands in CRM "Mensajes de Clientes").
  app.post('/customer/messages', require('./customerMessages').customerMessageCreate);
  app.get('/customer/messages/:conversationId', require('./customerMessages').customerMessageThread);
  app.post('/customer/messages/:conversationId', require('./customerMessages').customerMessageReply);
  app.post('/customer/messages/:conversationId/read', require('./customerMessages').customerMessageRead);
  // Register the client app's FCM token. Customer-scoped (tenant comes from the
  // JWT) so it never hits the permissioned /tenant/:id/device-id-information.
  // Same handler at two paths: the new RESTful one the apps requested + the
  // legacy alias, so existing builds keep working.
  app.post('/customer/me/device-id-information', require('./customerMessages').customerDeviceToken);
  app.post('/customer/device-token', require('./customerMessages').customerDeviceToken);
};
