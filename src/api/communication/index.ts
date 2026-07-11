/**
 * Unified communications — authed admin routes (tenant-scoped). The public Meta
 * WhatsApp webhook is mounted separately, BEFORE authMiddleware, in
 * src/api/index.ts (see metaWebhook.ts).
 */
import { settingsGet, settingsPut, logsGet, walletGet, walletRecharge } from './communicationEndpoints';

export default (app) => {
  app.get('/tenant/:tenantId/communications/settings', settingsGet);
  app.put('/tenant/:tenantId/communications/settings', settingsPut);
  app.get('/tenant/:tenantId/communications/logs', logsGet);
  app.get('/tenant/:tenantId/communications/wallet', walletGet);
  app.post('/tenant/:tenantId/communications/wallet/recharge', walletRecharge);
};
