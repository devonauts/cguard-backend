import {
  radioConsole,
  radioStart,
  radioSessions,
  radioSessionGet,
  radioSessionCancel,
  radioSessionSummary,
  radioEntryEscalate,
  radioSettingsGet,
  radioSettingsPut,
} from './radioCheckEndpoints';

/** CRM radio-check (pase de novedades) dispatcher routes. */
export default (app) => {
  app.get('/tenant/:tenantId/radio-check/console', radioConsole);
  app.post('/tenant/:tenantId/radio-check/start', radioStart);
  app.get('/tenant/:tenantId/radio-check/sessions', radioSessions);
  app.get('/tenant/:tenantId/radio-check/sessions/:id', radioSessionGet);
  app.post('/tenant/:tenantId/radio-check/sessions/:id/cancel', radioSessionCancel);
  app.post('/tenant/:tenantId/radio-check/sessions/:id/summary', radioSessionSummary);
  app.post('/tenant/:tenantId/radio-check/entries/:entryId/escalate', radioEntryEscalate);
  app.get('/tenant/:tenantId/radio-check/settings', radioSettingsGet);
  app.put('/tenant/:tenantId/radio-check/settings', radioSettingsPut);
};
