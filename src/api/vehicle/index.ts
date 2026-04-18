export default (routes) => {
  routes.get('/tenant/:tenantId/vehicle', require('./vehicleList').default);
  routes.get('/tenant/:tenantId/vehicle/autocomplete', require('./vehicleAutocomplete').default);
  routes.post('/tenant/:tenantId/vehicle', require('./vehicleCreate').default);
  routes.get('/tenant/:tenantId/vehicle/:id', require('./vehicleFind').default);
  routes.put('/tenant/:tenantId/vehicle/:id', require('./vehicleUpdate').default);
  routes.delete('/tenant/:tenantId/vehicle/:id', require('./vehicleDestroy').default);
};
