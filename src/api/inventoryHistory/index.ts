export default (app) => {
  app.post(
    `/tenant/:tenantId/inventory-history`,
    require('./inventoryHistoryCreate').default,
  );
  app.delete(
    `/tenant/:tenantId/inventory-history`,
    require('./inventoryHistoryDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/inventory-history`,
    require('./inventoryHistoryList').default,
  );

  // Patrol-scoped inventory history endpoints


};
