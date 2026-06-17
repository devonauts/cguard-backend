/**
 * Twilio webhook handlers (PLATFORM phone center). Mounted at ROOT, PRE-AUTH in
 * src/api/index.ts:
 *   POST /communications/webhooks/twilio/sms            -> twilioSmsInbound
 *   POST /communications/webhooks/twilio/sms-status     -> twilioSmsStatus
 *   POST /communications/webhooks/twilio/voice          -> twilioVoiceInbound   (TwiML)
 *   POST /communications/webhooks/twilio/voice-status   -> twilioVoiceStatus
 *   POST /communications/webhooks/twilio/voice-outbound -> twilioVoiceOutbound  (TwiML, TwiML App Voice URL)
 *
 * Twilio POSTs application/x-www-form-urlencoded, so these routes are mounted
 * with an express.urlencoded({ extended: false }) parser (see index.ts).
 *
 * SECURITY: every handler validates X-Twilio-Signature against the decrypted
 * platform authToken + the exact full public URL + the posted params. If no
 * authToken is configured we warn and skip validation (so an unconfigured
 * environment fails open only to itself, never to attackers in prod).
 */
import { Request, Response } from 'express';
import { getTwilioConfig } from '../../services/twilio/twilioPlatformConfigService';
import {
  validateSignature,
  buildIncomingCallTwiml,
  buildOutboundCallTwiml,
} from '../../services/twilio/twilioClient';
import {
  recordInbound,
  updateMessageStatus,
} from '../../services/twilio/superadminMessagingService';
import { recordCall, updateCall } from '../../services/twilio/superadminCallService';

/** The models bag attached by databaseMiddleware. */
function db(req: Request): any {
  return (req as any).database;
}

/** Reconstruct the exact public URL Twilio signed. */
function fullUrl(req: Request): string {
  const base = (process.env.TWILIO_PUBLIC_BASE_URL || 'https://api.cguardpro.com').replace(
    /\/+$/,
    '',
  );
  return base + req.originalUrl;
}

/** Reply with TwiML (XML). */
function sendTwiml(res: Response, twiml: string): void {
  res.set('Content-Type', 'text/xml');
  res.status(200).send(twiml);
}

/**
 * Verify the request signature. Returns true to proceed; false means we've
 * already sent a 403. Skips (proceeds) with a warning when no authToken set.
 */
async function ensureSignature(req: Request, res: Response): Promise<boolean> {
  try {
    const cfg = await getTwilioConfig(db(req));
    if (!cfg.authToken) {
      console.warn('[twilio webhook] no authToken configured — skipping signature validation');
      return true;
    }
    const sig = (req.headers['x-twilio-signature'] as string) || '';
    const ok = validateSignature(cfg.authToken, sig, fullUrl(req), req.body || {});
    if (!ok) {
      console.warn('[twilio webhook] invalid X-Twilio-Signature for', req.originalUrl);
      res.status(403).send('Invalid Twilio signature');
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[twilio webhook] signature check error:', e?.message || e);
    res.status(403).send('Signature validation failed');
    return false;
  }
}

/** Collect MediaUrl0..N from a Twilio SMS/MMS payload. */
function collectMediaUrls(body: any): string[] {
  const n = parseInt(body?.NumMedia, 10) || 0;
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = body[`MediaUrl${i}`];
    if (u) urls.push(String(u));
  }
  return urls;
}

/** POST /communications/webhooks/twilio/sms — inbound SMS/MMS. */
export async function twilioSmsInbound(req: Request, res: Response): Promise<void> {
  if (!(await ensureSignature(req, res))) return;
  try {
    const b: any = req.body || {};
    await recordInbound(db(req), {
      from: b.From,
      to: b.To,
      body: b.Body || '',
      twilioSid: b.MessageSid || b.SmsSid,
      mediaUrls: collectMediaUrls(b),
    });
  } catch (e: any) {
    console.error('[twilio webhook] sms inbound error:', e?.message || e);
  }
  // Empty TwiML — we handle replies from the panel, not auto-reply.
  sendTwiml(res, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

/** POST /communications/webhooks/twilio/sms-status — outbound delivery status. */
export async function twilioSmsStatus(req: Request, res: Response): Promise<void> {
  if (!(await ensureSignature(req, res))) return;
  try {
    const b: any = req.body || {};
    const sid = b.MessageSid || b.SmsSid;
    const status = b.MessageStatus || b.SmsStatus;
    if (sid && status) {
      await updateMessageStatus(db(req), sid, status, b.ErrorMessage || b.ErrorCode);
    }
  } catch (e: any) {
    console.error('[twilio webhook] sms status error:', e?.message || e);
  }
  res.status(204).end();
}

/** POST /communications/webhooks/twilio/voice — inbound PSTN call → ring browser. */
export async function twilioVoiceInbound(req: Request, res: Response): Promise<void> {
  if (!(await ensureSignature(req, res))) return;
  try {
    const b: any = req.body || {};
    await recordCall(db(req), {
      callSid: b.CallSid,
      direction: 'inbound',
      from: b.From,
      to: b.To,
      status: b.CallStatus || 'ringing',
    });
  } catch (e: any) {
    console.error('[twilio webhook] voice inbound error:', e?.message || e);
  }
  // Ring the shared superadmin browser client.
  sendTwiml(res, buildIncomingCallTwiml({ clientIdentity: 'superadmin' }));
}

/** POST /communications/webhooks/twilio/voice-status — call lifecycle updates. */
export async function twilioVoiceStatus(req: Request, res: Response): Promise<void> {
  if (!(await ensureSignature(req, res))) return;
  try {
    const b: any = req.body || {};
    if (b.CallSid) {
      const dur = b.CallDuration ? parseInt(b.CallDuration, 10) : undefined;
      const ended = ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(
        String(b.CallStatus),
      );
      await updateCall(db(req), b.CallSid, {
        status: b.CallStatus,
        durationSec: dur,
        endedAt: ended ? new Date() : undefined,
        from: b.From,
        to: b.To,
        direction: b.Direction && /outbound/i.test(b.Direction) ? 'outbound' : undefined,
        recordingUrl: b.RecordingUrl || undefined,
      });
    }
  } catch (e: any) {
    console.error('[twilio webhook] voice status error:', e?.message || e);
  }
  res.status(204).end();
}

/**
 * POST /communications/webhooks/twilio/voice-outbound — the TwiML App Voice URL
 * for BROWSER-originated outbound calls. Dials the {To} param as PSTN with the
 * platform number as caller ID.
 */
export async function twilioVoiceOutbound(req: Request, res: Response): Promise<void> {
  if (!(await ensureSignature(req, res))) return;
  let callerId = '';
  let to = '';
  try {
    const b: any = req.body || {};
    to = b.To || '';
    const cfg = await getTwilioConfig(db(req));
    callerId = cfg.phoneNumber || '';
    if (b.CallSid) {
      await recordCall(db(req), {
        callSid: b.CallSid,
        direction: 'outbound',
        from: callerId,
        to,
        status: b.CallStatus || 'in-progress',
      });
    }
  } catch (e: any) {
    console.error('[twilio webhook] voice outbound error:', e?.message || e);
  }
  sendTwiml(res, buildOutboundCallTwiml({ to, callerId }));
}

export default {
  twilioSmsInbound,
  twilioSmsStatus,
  twilioVoiceInbound,
  twilioVoiceStatus,
  twilioVoiceOutbound,
};
