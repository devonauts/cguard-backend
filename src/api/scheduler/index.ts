export default (app) => {
  /**
   * POST /api/tenant/:tenantId/scheduler/generate
   * 
   * Uses AI to generate an optimal shift schedule for a station.
   * Input: stationId, startDate, endDate, constraints
   * Output: proposed shifts with guard assignments, sacafranco coverage, cost estimate
   */
  app.post(
    `/tenant/:tenantId/scheduler/generate`,
    require('./schedulerGenerate').default,
  );

  /**
   * POST /api/tenant/:tenantId/scheduler/apply
   *
   * Takes generated schedule and creates actual shift records.
   */
  app.post(
    `/tenant/:tenantId/scheduler/apply`,
    require('./schedulerApply').default,
  );
};
