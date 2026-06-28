export default (app) => {
  // WORKER/guard app scans a customer-created visitor pre-authorization QR.
  // Tenant-scoped; gated by visitorLogCreate (every guard role already has it).
  app.post(
    `/tenant/:tenantId/visitor-preauth/scan`,
    require('./visitorPreAuthScan').default,
  );
};
