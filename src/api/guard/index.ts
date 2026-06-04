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

  // Start a patrol (stamps startAt + notifies tenant/client per settings)
  app.post(
    `/tenant/:tenantId/guard/me/patrol/start`,
    require('./guardMePatrolStart').default,
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
