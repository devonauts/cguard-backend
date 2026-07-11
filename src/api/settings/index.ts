export default (app) => {
  app.put(
    `/tenant/:tenantId/settings`,
    require('./settingsSave').default,
  );
  app.get(
    `/tenant/:tenantId/settings`,
    require('./settingsFind').default,
  );
  // Team mobile hub: resolved worker/supervisor-app customization. Auth +
  // tenant membership only (guards need it at launch — branding, not sensitive).
  app.get(
    `/tenant/:tenantId/mobile-app-config`,
    require('./settingsMobileAppConfig').default,
  );
};
