export default (app) => {
  // A guard's reported devices (admin guard-detail "Dispositivo" tab)
  app.get(
    `/tenant/:tenantId/guard-device/by-guard/:userId`,
    require('./guardDeviceByGuard').default,
  );

  // Reset a guard's device binding (e.g. new phone)
  app.post(
    `/tenant/:tenantId/guard-device/:id/reset-binding`,
    require('./guardDeviceReset').default,
  );
};
