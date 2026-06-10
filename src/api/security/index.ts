export default (app) => {
  app.get('/tenant/:tenantId/security/audit-logs', require('./auditLogs').default);
};
