export default (app) => {
  app.post(`/tenant/:tenantId/global-inventory`, require('./inventoryItemCreate').default);
  app.put(`/tenant/:tenantId/global-inventory/:id`, require('./inventoryItemUpdate').default);
  app.patch(`/tenant/:tenantId/global-inventory/:id`, require('./inventoryItemUpdate').default);
  app.delete(`/tenant/:tenantId/global-inventory`, require('./inventoryItemDestroy').default);
  app.delete(`/tenant/:tenantId/global-inventory/:id`, require('./inventoryItemDestroy').default);
  app.get(`/tenant/:tenantId/global-inventory/autocomplete`, require('./inventoryItemAutocomplete').default);
  app.get(`/tenant/:tenantId/global-inventory`, require('./inventoryItemList').default);
  app.get(`/tenant/:tenantId/global-inventory/:id`, require('./inventoryItemFind').default);
};
