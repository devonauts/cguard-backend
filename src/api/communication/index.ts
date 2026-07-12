/**
 * Unified communications — authed admin routes (tenant-scoped). The public Meta
 * WhatsApp webhook is mounted separately, BEFORE authMiddleware, in
 * src/api/index.ts (see metaWebhook.ts).
 */
import { settingsGet, settingsPut, logsGet, walletGet, walletRecharge } from './communicationEndpoints';
import {
  whatsappStatusGet,
  whatsappConnectPost,
  whatsappCallbackPost,
  whatsappDisconnectPost,
  whatsappRegisterPost,
  whatsappSyncTemplatesPost,
} from './whatsappEndpoints';

export default (app) => {
  app.get('/tenant/:tenantId/communications/settings', settingsGet);
  app.put('/tenant/:tenantId/communications/settings', settingsPut);
  app.get('/tenant/:tenantId/communications/logs', logsGet);
  app.get('/tenant/:tenantId/communications/wallet', walletGet);
  app.post('/tenant/:tenantId/communications/wallet/recharge', walletRecharge);

  // Per-tenant WhatsApp Business (Meta Embedded Signup).
  app.get('/tenant/:tenantId/communications/whatsapp/status', whatsappStatusGet);
  app.post('/tenant/:tenantId/communications/whatsapp/connect', whatsappConnectPost);
  app.post('/tenant/:tenantId/communications/whatsapp/callback', whatsappCallbackPost);
  app.post('/tenant/:tenantId/communications/whatsapp/disconnect', whatsappDisconnectPost);
  app.post('/tenant/:tenantId/communications/whatsapp/register', whatsappRegisterPost);
  app.post('/tenant/:tenantId/communications/whatsapp/sync-templates', whatsappSyncTemplatesPost);
};
