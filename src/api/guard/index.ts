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
