import multer from 'multer';

// Memory-storage multipart parser for customer file uploads. `multipartParser`
// in src/api/index.ts is module-local and not exported, so we instantiate our
// own (same `multer()` default) and apply it per-route.
const multipartParser = multer();

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

  // Client uploads/replaces their own profile picture → becomes the
  // clientAccount's logoUrl (avatar in the Mi Seguridad header). multipart/form-data
  // with a single `file` field. Returns { success, downloadUrl }.
  app.post(
    '/customer/me/profile-picture',
    multipartParser.single('file'),
    require('./customerProfilePicture').default,
  );

  // Client tasks: create a to-do for one of the client's stations (pending CRM
  // approval) + list the client's own tasks with status.
  app.post('/customer/tasks', require('./customerTasks').customerTaskCreate);
  app.get('/customer/tasks', require('./customerTasks').customerTaskList);

  // Client asks for a visitor to be REMOVED from one of their installations.
  // Creates a pending_approval task (worker app + CRM) and pushes the station's
  // guards. Mirrors POST /customer/tasks registration.
  app.post(
    '/customer/visitor-log/:id/request-removal',
    require('./visitorRemovalRequest').customerVisitorRemovalRequest,
  );

  // ── Mi Seguridad safety endpoints (customer-scoped to the JWT's clientAccount).
  // SOS panic button (creates a HIGH incident + notifies CRM + pushes the
  // station's on-duty guards), live guard-location map, geofenced clock-in proof
  // feed, and customer-driven incident escalation. All strictly scoped to the
  // customer's own stations. Mirror the registration of /customer/tasks above.
  app.post('/customer/sos', require('./customerSafety').customerSos);
  app.get('/customer/guard-locations', require('./customerSafety').customerGuardLocations);
  app.get('/customer/clock-ins', require('./customerSafety').customerClockIns);
  app.post('/customer/incident/:id/escalate', require('./customerSafety').customerIncidentEscalate);
};
