export default (app) => {
  app.post(`/tenant/:tenantId/inventory-assignment`, require('./inventoryAssignmentCreate').default);
  app.put(`/tenant/:tenantId/inventory-assignment/:id`, require('./inventoryAssignmentUpdate').default);
  app.patch(`/tenant/:tenantId/inventory-assignment/:id`, require('./inventoryAssignmentUpdate').default);
  app.delete(`/tenant/:tenantId/inventory-assignment`, require('./inventoryAssignmentDestroy').default);
  app.delete(`/tenant/:tenantId/inventory-assignment/:id`, require('./inventoryAssignmentDestroy').default);
  app.get(`/tenant/:tenantId/inventory-assignment`, require('./inventoryAssignmentList').default);
  app.get(`/tenant/:tenantId/inventory-assignment/:id`, require('./inventoryAssignmentFind').default);
};
