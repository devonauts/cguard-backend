/**
 * Guard-facing endpoints (authenticated guard users).
 * All endpoints require a valid JWT with securityGuard role.
 */
export default (app) => {
  // Dashboard: guard's assigned station, current shift, status
  app.get(
    `/tenant/:tenantId/guard/me`,
    require('./guardMe').default,
  );

  // My schedule (upcoming shifts)
  app.get(
    `/tenant/:tenantId/guard/me/schedule`,
    require('./guardMeSchedule').default,
  );

  // Summary of my most recent completed shift (last-shift card)
  app.get(
    `/tenant/:tenantId/guard/me/last-shift`,
    require('./guardMeLastShift').default,
  );

  // Internal messaging (CRM ↔ this guard)
  app.get(`/tenant/:tenantId/guard/me/messages`, require('./guardMeMessages').guardMessagesList);
  app.post(`/tenant/:tenantId/guard/me/messages`, require('./guardMeMessages').guardMessageCreate);
  app.get(`/tenant/:tenantId/guard/me/messages/:conversationId`, require('./guardMeMessages').guardMessageThread);
  app.post(`/tenant/:tenantId/guard/me/messages/:conversationId`, require('./guardMeMessages').guardMessageReply);
  app.post(`/tenant/:tenantId/guard/me/messages/:conversationId/read`, require('./guardMeMessages').guardMessageRead);

  // Radio check (pase de novedades) — the guard answers a roll-call request.
  app.get(`/tenant/:tenantId/guard/me/radio-check/pending`, require('./guardMeRadioCheck').guardRadioPending);
  app.post(`/tenant/:tenantId/guard/me/radio-check/entries/:entryId/reply`, require('./guardMeRadioCheck').guardRadioReply);

  // Team roster on duty at my current sitio de servicio (post site)
  app.get(
    `/tenant/:tenantId/guard/me/team`,
    require('./guardMeTeam').default,
  );

  // Effective patrol (ronda) settings for my post site
  app.get(
    `/tenant/:tenantId/guard/me/ronda-settings`,
    require('./guardMeRondaSettings').default,
  );

  // My patrol history (tour assignments)
  app.get(
    `/tenant/:tenantId/guard/me/patrols`,
    require('./guardMePatrols').default,
  );

  // Today's due consignas for my station(s) + their completion status
  app.get(
    `/tenant/:tenantId/guard/me/orders`,
    require('./guardMeOrders').default,
  );
  // Complete today's occurrence of a consigna (note + photo/video/audio)
  app.post(
    `/tenant/:tenantId/guard/me/orders/:id/complete`,
    require('./guardMeOrderComplete').default,
  );

  // Recent site activity (on-duty home feed)
  app.get(
    `/tenant/:tenantId/guard/me/activity`,
    require('./guardMeActivity').default,
  );

  // Memos addressed to me + acknowledgment
  app.get(
    `/tenant/:tenantId/guard/me/memos`,
    require('./guardMeMemos').default,
  );
  app.post(
    `/tenant/:tenantId/guard/me/memos/:id/accept`,
    require('./guardMeMemoAccept').default,
  );

  // Start a patrol (stamps startAt + notifies tenant/client per settings)
  app.post(
    `/tenant/:tenantId/guard/me/patrol/start`,
    require('./guardMePatrolStart').default,
  );

  // Update my own contact details (phone/address) — notifies HR in the CRM
  app.patch(
    `/tenant/:tenantId/guard/me/profile`,
    require('./guardMeProfileUpdate').default,
  );

  // Register my device identity (deviceId + model/OS/app version) — bind/flag
  app.post(
    `/tenant/:tenantId/guard/me/device`,
    require('./guardMeDevice').default,
  );

  // Register my FCM device token for push
  app.post(
    `/tenant/:tenantId/guard/me/device-token`,
    require('./guardMeDeviceToken').default,
  );

  // My performance score + breakdown
  app.get(
    `/tenant/:tenantId/guard/me/performance`,
    require('./guardMePerformance').default,
  );

  // My station security test (sanitized random N questions) + submit
  app.get(
    `/tenant/:tenantId/guard/me/quiz`,
    require('./guardMeQuiz').default,
  );
  app.post(
    `/tenant/:tenantId/guard/me/quiz/submit`,
    require('./guardMeQuizSubmit').default,
  );

  // Backup pool: open (at-risk) shifts I can cover + volunteering
  app.get(
    `/tenant/:tenantId/guard/me/backup/open`,
    require('./guardMeBackupOpen').default,
  );
  app.post(
    `/tenant/:tenantId/guard/me/backup/volunteer`,
    require('./guardMeBackupVolunteer').default,
  );

  // Late clock-in approval request (create + status) — registered BEFORE the
  // bare /clock-in POST so the static /clock-in/request path is unambiguous.
  app.post(
    `/tenant/:tenantId/guard/me/clock-in/request`,
    require('./guardMeClockInRequestCreate').default,
  );
  app.get(
    `/tenant/:tenantId/guard/me/clock-in/request`,
    require('./guardMeClockInRequestGet').default,
  );

  // Clock in (geofence validated)
  app.post(
    `/tenant/:tenantId/guard/me/clock-in`,
    require('./guardMeClockIn').default,
  );

  // Clock out
  app.post(
    `/tenant/:tenantId/guard/me/clock-out`,
    require('./guardMeClockOut').default,
  );

  // Early clock-out approval request (create + status)
  app.post(
    `/tenant/:tenantId/guard/me/clock-out/request`,
    require('./guardMeClockOutRequestCreate').default,
  );
  app.get(
    `/tenant/:tenantId/guard/me/clock-out/request`,
    require('./guardMeClockOutRequestGet').default,
  );
  app.post(
    `/tenant/:tenantId/guard/me/clock-out/request/cancel`,
    require('./guardMeClockOutRequestCancel').default,
  );

  // Report an incident about my post (panic / events) — no admin perm needed
  app.post(
    `/tenant/:tenantId/guard/me/incident`,
    require('./guardMeIncidentCreate').default,
  );

  // My time-off requests
  app.get(
    `/tenant/:tenantId/guard/me/time-off`,
    require('./guardMeTimeOff').default,
  );

  // Request time off
  app.post(
    `/tenant/:tenantId/guard/me/time-off`,
    require('./guardMeTimeOffCreate').default,
  );
};
