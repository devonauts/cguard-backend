/**
 * SuperAdmin · platform Twilio phone center routes.
 * Mounted under /api/superadmin by ./index.ts, behind requireSuperadmin.
 *
 * Config secrets are write-only (GET returns last4 + configured flags only).
 * Logic lives in ../../services/twilio/*.
 *
 * Routes:
 *   GET  /settings/twilio                    -> masked config
 *   PUT  /settings/twilio                    -> upsert config
 *   POST /settings/twilio/test               -> verify credentials
 *   GET  /twilio/numbers                     -> list incoming numbers
 *   POST /twilio/numbers/configure           -> point a number's webhooks at us
 *   GET  /twilio/voice-token                 -> in-browser softphone access token
 *   GET  /twilio/conversations               -> SMS conversation list
 *   GET  /twilio/conversations/:id/messages  -> messages in a thread
 *   POST /twilio/conversations/:id/read      -> clear unread badge
 *   POST /twilio/messages   { to, body }     -> send SMS + persist
 *   GET  /twilio/calls                       -> call log
 *   POST /twilio/calls      { to }           -> server-initiated outbound call
 */
import ApiResponseHandler from '../apiResponseHandler';
import { db, writeAudit } from '../../services/superadmin/superadminHelpers';
import {
  getTwilioSettingsMasked,
  saveTwilioSettings,
  testTwilioConnection,
  getTwilioConfig,
} from '../../services/twilio/twilioPlatformConfigService';
import {
  listIncomingNumbers,
  configureNumberWebhooks,
  generateVoiceToken,
  sendSms,
  getClient,
  webhookUrls,
} from '../../services/twilio/twilioClient';
import {
  listConversations,
  listMessages,
  markRead,
  recordOutbound,
} from '../../services/twilio/superadminMessagingService';
import { listCalls, recordCall } from '../../services/twilio/superadminCallService';

export default (router) => {
  // ---- Settings ----------------------------------------------------------

  router.get('/settings/twilio', async (req, res) => {
    try {
      const payload = await getTwilioSettingsMasked(db(req));
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.put('/settings/twilio', async (req, res) => {
    try {
      const payload = await saveTwilioSettings(req, req.body || {});
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.post('/settings/twilio/test', async (req, res) => {
    try {
      const payload = await testTwilioConnection(db(req));
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- Numbers -----------------------------------------------------------

  router.get('/twilio/numbers', async (req, res) => {
    try {
      const payload = await listIncomingNumbers(db(req));
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.post('/twilio/numbers/configure', async (req, res) => {
    try {
      const body = req.body || {};
      const urls = webhookUrls();
      const payload = await configureNumberWebhooks(db(req), {
        phoneSid: body.phoneSid,
        phoneNumber: body.phoneNumber,
        smsUrl: urls.smsUrl,
        voiceUrl: urls.voiceUrl,
        statusUrls: { smsStatusUrl: urls.smsStatusUrl, voiceStatusUrl: urls.voiceStatusUrl },
      });
      await writeAudit(req, {
        action: 'twilio.numbers.configure',
        targetType: 'twilioNumber',
        targetId: payload && payload.sid,
        statusCode: 200,
        details: { phoneNumber: payload && payload.phoneNumber },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- Voice token (in-browser softphone) --------------------------------

  router.get('/twilio/voice-token', async (req, res) => {
    try {
      const { token, identity } = await generateVoiceToken(db(req), 'superadmin');
      await ApiResponseHandler.success(req, res, { token, identity });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- SMS conversations / messages --------------------------------------

  router.get('/twilio/conversations', async (req, res) => {
    try {
      const payload = await listConversations(db(req), {
        page: parseInt(req.query.page, 10) || 1,
        limit: parseInt(req.query.limit, 10) || 50,
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.get('/twilio/conversations/:id/messages', async (req, res) => {
    try {
      const payload = await listMessages(db(req), req.params.id, {
        page: parseInt(req.query.page, 10) || 1,
        limit: parseInt(req.query.limit, 10) || 50,
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.post('/twilio/conversations/:id/read', async (req, res) => {
    try {
      const payload = await markRead(db(req), req.params.id);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  router.post('/twilio/messages', async (req, res) => {
    try {
      const { to, body } = req.body || {};
      if (!to || !body) {
        const err: any = new Error('`to` and `body` are required.');
        err.code = 400;
        throw err;
      }
      const database = db(req);
      const cfg = await getTwilioConfig(database);
      const sent = await sendSms(database, { to, body });
      const result = await recordOutbound(database, {
        to,
        body,
        twilioSid: sent && sent.sid,
        status: (sent && sent.status) || 'queued',
        ourNumber: cfg.phoneNumber,
      });
      await writeAudit(req, {
        action: 'twilio.sms.send',
        targetType: 'twilioMessage',
        targetId: sent && sent.sid,
        statusCode: 200,
        details: { to },
      });
      await ApiResponseHandler.success(req, res, result);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- Calls -------------------------------------------------------------

  router.get('/twilio/calls', async (req, res) => {
    try {
      const payload = await listCalls(db(req), {
        page: parseInt(req.query.page, 10) || 1,
        limit: parseInt(req.query.limit, 10) || 50,
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Optional server-initiated outbound call (PSTN ← platform number). The
  // browser softphone normally dials via the Voice SDK; this is a fallback.
  router.post('/twilio/calls', async (req, res) => {
    try {
      const { to } = req.body || {};
      if (!to) {
        const err: any = new Error('`to` is required.');
        err.code = 400;
        throw err;
      }
      const database = db(req);
      const cfg = await getTwilioConfig(database);
      if (!cfg.phoneNumber) {
        const err: any = new Error('No platform phone number configured.');
        err.code = 400;
        throw err;
      }
      const client = await getClient(database);
      const urls = webhookUrls();
      const call = await client.calls.create({
        to,
        from: cfg.phoneNumber,
        url: urls.voiceOutboundUrl,
        statusCallback: urls.voiceStatusUrl,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });
      const payload = await recordCall(database, {
        callSid: call.sid,
        direction: 'outbound',
        from: cfg.phoneNumber,
        to,
        status: call.status,
      });
      await writeAudit(req, {
        action: 'twilio.call.create',
        targetType: 'twilioCall',
        targetId: call.sid,
        statusCode: 200,
        details: { to },
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
