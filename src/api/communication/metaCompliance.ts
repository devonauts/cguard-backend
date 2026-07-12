/**
 * Meta app compliance callbacks (public, mounted BEFORE authMiddleware in
 * src/api/index.ts, next to the WhatsApp webhook):
 *
 *   POST /communications/webhooks/meta/deauthorize
 *     Called by Meta when a business/user removes the CGuardPro app from
 *     their Meta settings (deauthorizes us OUTSIDE our UI). Body is
 *     application/x-www-form-urlencoded with a `signed_request` param.
 *     The payload only identifies the Facebook user (not the WABA), so we
 *     can't map it to a tenant deterministically — we verify + audit-log the
 *     event; the tenant's stored token simply starts failing and the webhook
 *     account_update/ban handlers + send-path errors surface the disconnect.
 *
 *   POST /communications/webhooks/meta/data-deletion
 *     Meta's Data Deletion Request callback. Must respond with JSON
 *     { url, confirmation_code } pointing at a human-readable status page.
 *
 * signed_request format: "<base64url(sig)>.<base64url(json)>" where sig is
 * HMAC-SHA256 over the raw payload segment using the app secret.
 */
import crypto from 'crypto';
import { getMetaConfig } from '../../services/communication/communicationSettingsService';

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Verify + parse a Meta signed_request. Returns the payload or null. */
function parseSignedRequest(signedRequest: string, appSecret: string): any | null {
  try {
    const [encodedSig, encodedPayload] = String(signedRequest).split('.', 2);
    if (!encodedSig || !encodedPayload) return null;
    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(encodedPayload)
      .digest();
    const given = b64urlDecode(encodedSig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return null;
    }
    return JSON.parse(b64urlDecode(encodedPayload).toString('utf8'));
  } catch {
    return null;
  }
}

async function resolveAppSecret(db: any): Promise<string> {
  const cfg = await getMetaConfig(db).catch(() => null);
  return cfg?.appSecret || process.env.META_APP_SECRET || '';
}

export const metaDeauthorize = async (req: any, res: any) => {
  try {
    const appSecret = await resolveAppSecret(req.database);
    const payload = appSecret
      ? parseSignedRequest(req.body?.signed_request, appSecret)
      : null;
    if (!payload) {
      // Invalid/unverifiable — reject so a forged request gets no ACK.
      return res.status(400).json({ message: 'invalid signed_request' });
    }
    console.warn(
      `[whatsapp] Meta app deauthorized by FB user ${payload.user_id || 'unknown'} — ` +
        'the affected tenant token will start failing; watch account_update webhooks / send errors.',
    );
    try {
      const { logSecurityEvent } = require('../../services/auth/securityAudit');
      await logSecurityEvent(req.database, {
        event: 'whatsapp_deauthorized',
        outcome: 'success',
        detail: `fb user ${payload.user_id || 'unknown'}`,
      });
    } catch {
      /* best-effort */
    }
    return res.status(200).json({ received: true });
  } catch (e: any) {
    // Never 500 back at Meta on our own faults.
    console.error('[whatsapp] deauthorize callback error:', e?.message || e);
    return res.status(200).json({ received: true });
  }
};

export const metaDataDeletion = async (req: any, res: any) => {
  try {
    const appSecret = await resolveAppSecret(req.database);
    const payload = appSecret
      ? parseSignedRequest(req.body?.signed_request, appSecret)
      : null;
    if (!payload) {
      return res.status(400).json({ message: 'invalid signed_request' });
    }
    const confirmationCode = crypto.randomBytes(8).toString('hex');
    console.warn(
      `[whatsapp] Meta data-deletion request for FB user ${payload.user_id || 'unknown'} ` +
        `(confirmation ${confirmationCode}). We store no FB user data; WhatsApp tokens are ` +
        'tenant-owned and removable via Configuración → Comunicaciones → Desconectar.',
    );
    try {
      const { logSecurityEvent } = require('../../services/auth/securityAudit');
      await logSecurityEvent(req.database, {
        event: 'meta_data_deletion_request',
        outcome: 'success',
        detail: `fb user ${payload.user_id || 'unknown'} code ${confirmationCode}`,
      });
    } catch {
      /* best-effort */
    }
    // Meta requires { url, confirmation_code } pointing at a status page.
    return res.status(200).json({
      url: `https://cguardpro.com/privacy?deletion=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  } catch (e: any) {
    console.error('[whatsapp] data-deletion callback error:', e?.message || e);
    return res.status(200).json({ received: true });
  }
};

export default { metaDeauthorize, metaDataDeletion };
