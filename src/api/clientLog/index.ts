export default (routes) => {
  routes.post(`/tenant/:tenantId/client-log`, require('./clientLogCreate').default);
};
