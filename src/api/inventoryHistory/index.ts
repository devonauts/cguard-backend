export default (app) => {
  app.post(
    `/tenant/:tenantId/inventory-history`,
    require('./inventoryHistoryCreate').default,
  );
  app.put(
    `/tenant/:tenantId/inventory-history/:id`,
    require('./inventoryHistoryUpdate').default,
  );
  app.post(
    `/tenant/:tenantId/inventory-history/import`,
    require('./inventoryHistoryImport').default,
  );
  app.delete(
    `/tenant/:tenantId/inventory-history`,
    require('./inventoryHistoryDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/inventory-history/autocomplete`,
    require('./inventoryHistoryAutocomplete').default,
  );
  app.get(
    `/tenant/:tenantId/inventory-history`,
    require('./inventoryHistoryList').default,
  );
  app.get(
    `/tenant/:tenantId/inventory-history/:id`,
    require('./inventoryHistoryFind').default,
  );

  // Patrol-scoped inventory history endpoints
  app.post(
    `/tenant/:tenantId/patrols/:patrolId/inventory-history`,
    require('./patrolInventoryCreate').default,
  );

  app.post(
    `/tenant/:tenantId/patrols/:patrolId/confirm-inventories`,
    require('./patrolConfirmInventories').default,
  );

  app.get(
    `/tenant/:tenantId/patrols/:patrolId/inventory-history`,
    require('./patrolInventoryList').default,
  );
};
