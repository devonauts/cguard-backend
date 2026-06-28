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

  // ── Visitor pre-authorization (QR pass). The customer pre-registers an expected
  // visitor and receives a qrToken/qrPayload the app renders as a QR image; the
  // guard app scans it via /tenant/:tenantId/visitor-preauth/scan. Customer-scoped
  // to the JWT's clientAccount. Mirror the registration of /customer/sos above.
  app.post('/customer/visitor-preauth', require('./customerVisitorPreAuth').customerVisitorPreAuthCreate);
  app.get('/customer/visitor-preauth', require('./customerVisitorPreAuth').customerVisitorPreAuthList);
  app.post('/customer/visitor-preauth/:id/revoke', require('./customerVisitorPreAuth').customerVisitorPreAuthRevoke);

  // Client reports an incident at one of their stations (+ optional photos) →
  // lands in the CRM incident inbox (callerType:'client'), pushes station guards.
  // Photos: multipart `file` field(s) (binary) OR JSON `photos:[{url|downloadUrl}]`.
  // Returns { success, incidentId, photoCount }. GET lists the client's incidents.
  app.post(
    '/customer/incidents',
    multipartParser.array('file'),
    require('./customerIncidents').customerIncidentCreate,
  );
  app.get('/customer/incidents', require('./customerIncidents').customerIncidentList);

  // Client requests a service / extra guard / quote → REUSES the `request` model
  // (CRM "Solicitudes" inbox) scoped to the clientAccount; notifies supervisors.
  // GET lists the client's own requests with status.
  app.post('/customer/service-requests', require('./customerServiceRequests').customerServiceRequestCreate);
  app.get('/customer/service-requests', require('./customerServiceRequests').customerServiceRequestList);

  // Client rates a guard who is/was on shift at their station (1-5 + comment).
  // Verifies the shift before accepting; notifies the CRM (guard.rated). GET
  // returns this client's ratings for the guard (+ average).
  app.post('/customer/guards/:guardId/rating', require('./customerGuardRatings').customerGuardRatingCreate);
  app.get('/customer/guards/:guardId/ratings', require('./customerGuardRatings').customerGuardRatingList);

  // ── Customer reporting & analytics (customer-scoped to the JWT's clientAccount).
  // Exportable reports (CSV built manually / PDF via pdfkit) for incidents, patrols
  // and hours over a date range; and an analytics dashboard payload (incident trend,
  // severity split, patrol completion, hours delivered, per-station breakdown).
  // Both strictly scoped to the customer's own stations.
  app.get('/customer/reports/export', require('./customerReportsExport').default);
  app.get('/customer/analytics', require('./customerAnalytics').default);

  // ── Document vault (Feature #20). Aggregates the tenant compliance documents the
  // client is entitled to view (certifications + insurance policies) into one
  // flat list with signed downloadUrls + daysToExpiry. Customer-scoped via the JWT.
  app.get('/customer/documents', require('./customerDocuments').default);

  // ── Notification preferences (Feature #23). The client mutes/unmutes CATEGORIES
  // of push notifications (incidents, messages, coverage, visitors, patrols,
  // support, documents, digest, sos). clientNotifyService respects these before
  // sending a customer push. Customer-scoped via the JWT's clientAccount.
  app.get('/customer/notification-preferences', require('./customerNotificationPreferences').customerNotificationPreferencesList);
  app.put('/customer/notification-preferences', require('./customerNotificationPreferences').customerNotificationPreferencesUpdate);

  // ── In-app support ticketing (Feature #24, replaces the app's hardcoded mailto:).
  // Customer-scoped to the JWT's clientAccount: create + list + single (with reply
  // thread) + reply, all CRM-visible (notifies supervisors). Mirror the
  // registration of /customer/service-requests above.
  app.post('/customer/support-tickets', require('./customerSupportTickets').customerSupportTicketCreate);
  app.get('/customer/support-tickets', require('./customerSupportTickets').customerSupportTicketList);
  app.get('/customer/support-tickets/:id', require('./customerSupportTickets').customerSupportTicketGet);
  app.post('/customer/support-tickets/:id/reply', require('./customerSupportTickets').customerSupportTicketReply);
};
