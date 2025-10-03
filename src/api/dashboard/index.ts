export default (app) => {
  app.get(
    `/tenant/:tenantId/dashboard/stats`,
    require('./dashboardStats').default,
  );
};