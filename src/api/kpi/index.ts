export default (app) => {
  app.post(`/tenant/:tenantId/kpi`, require('./kpiCreate').default);
  app.get(`/tenant/:tenantId/kpi`, require('./kpiList').default);
  app.get(`/tenant/:tenantId/kpi/autocomplete`, require('./kpiAutocomplete').default);
  app.get(`/tenant/:tenantId/kpi/:id`, require('./kpiFind').default);
  app.get(`/tenant/:tenantId/kpi/:id/pdf`, require('./kpiPdf').default);
  app.get(`/tenant/:tenantId/kpi/:id/excel`, require('./kpiExcel').default);
  app.put(`/tenant/:tenantId/kpi/:id`, require('./kpiUpdate').default);
  app.delete(`/tenant/:tenantId/kpi/:id`, require('./kpiDestroy').default);
};
