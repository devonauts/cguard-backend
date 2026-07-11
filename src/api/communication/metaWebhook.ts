/**
 * Meta WhatsApp Cloud API webhook — public (no auth).
 *
 *  GET  /communications/webhooks/meta/whatsapp
 *       Verification handshake: echoes hub.challenge when hub.verify_token
 *       matches the configured META_WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 *
 *  POST /communications/webhooks/meta/whatsapp
 *       Delivery status + inbound message callbacks. Verifies the X-Hub-
 *       Signature-256 HMAC against META_APP_SECRET when one is configured.
 *       Statuses → communicationLogService.updateStatusByProviderMessageId.
 *       Inbound → records lastInboundAt (TODO: 24h-window tracking by the
 *       Routing/Providers agent).
 *
 * Mounted BEFORE authMiddleware in src/api/index.ts. Uses req.database (set by
 * databaseMiddleware) and req.rawBody (captured globally) for signature verify.
 */
import crypto from 'crypto';
import { getMetaConfig } from '../../services/communication/communicationSettingsService';
import { updateStatusByProviderMessageId } from '../../services/communication/communicationLogService';
import { recordInbound } from '../../services/communication/whatsappSessionService';
import { DeliveryStatus } from '../../services/communication/types';

/** Map Meta status strings to our DeliveryStatus. */
function mapStatus(s: string): DeliveryStatus | null {
  switch ((s || '').toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Resolve which tenant(s) own the WhatsApp conversation with an inbound phone.
 * The Meta business number is platform-global, so inbound events carry no tenant
 * context; we attribute them to the tenant(s) that have an outbound WhatsApp log
 * to this recipient (matched with/without a leading '+'). Returns most-recent
 * first, deduped. Empty when no prior conversation exists.
 */
async function resolveTenantsForPhone(db: any, phone: string): Promise<string[]> {
  if (!db?.communicationLog || !phone) return [];
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return [];
  try {
    const { Op } = require('sequelize');
    const rows = await db.communicationLog.findAll({
      where: {
        channel: 'whatsapp',
        recipient: { [Op.in]: [phone, '+' + digits, digits] },
      },
      attributes: ['tenantId', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      const tid = r.tenantId || (r.get && r.get('tenantId'));
      if (tid && !seen.has(tid)) {
        seen.add(tid);
        out.push(tid);
      }
    }
    return out;
  } catch (e: any) {
    console.warn('[meta-webhook] resolveTenantsForPhone failed:', e?.message || e);
    return [];
  }
}

/** GET — verification handshake. */
export const metaWebhookVerify = async (req: any, res: any) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const cfg = await getMetaConfig(req.database).catch(() => null);
    const expected = (cfg && cfg.webhookVerifyToken) || process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';

    if (mode === 'subscribe' && token && expected && token === expected) {
      return res.status(200).send(String(challenge ?? ''));
    }
    return res.sendStatus(403);
  } catch (e: any) {
    console.warn('[meta-webhook] verify failed:', e?.message || e);
    return res.sendStatus(403);
  }
};

/** Verify the X-Hub-Signature-256 header against appSecret (when configured). */
function verifySignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) {
    // FAIL-CLOSED in production: no secret configured means we cannot verify,
    // so a forged WhatsApp callback must be rejected — never trusted. Only
    // dev/sandbox skips verification (to ease local testing).
    if (process.env.NODE_ENV === 'production') {
      console.error('[meta-webhook] REJECTED: no app secret configured in production — cannot verify signature');
      return false;
    }
    return true;
  }
  if (!header || !header.startsWith('sha256=')) return false;
  try {
    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody || '', 'utf8')
      .digest('hex');
    const provided = header.slice('sha256='.length);
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** POST — status + inbound callbacks. Always 200 quickly so Meta doesn't retry. */
export const metaWebhookReceive = async (req: any, res: any) => {
  try {
    const cfg = await getMetaConfig(req.database).catch(() => null);
    const appSecret = (cfg && cfg.appSecret) || process.env.META_APP_SECRET || '';
    const raw = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});

    if (!verifySignature(raw, req.headers['x-hub-signature-256'], appSecret)) {
      console.warn('[meta-webhook] signature verification failed');
      return res.sendStatus(403);
    }

    const body = req.body || {};
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};

        // Delivery statuses.
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          const mapped = mapStatus(st?.status);
          const pmid = st?.id;
          if (mapped && pmid) {
            const at = st?.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();
            await updateStatusByProviderMessageId(req.database, String(pmid), mapped, at).catch(
              () => undefined,
            );
          }
        }

        // Inbound messages → record lastInboundAt per (tenant, phone) so the
        // provider can send free-form WhatsApp within Meta's 24h window.
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const m of messages) {
          const from = m?.from;
          if (!from) continue;
          // sanitize: only digits/+, cap length.
          const clean = String(from).replace(/[^\d+]/g, '').slice(0, 24);
          if (!clean) continue;
          const at = m?.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
          // The Meta number is platform-global; attribute the inbound to the
          // tenant(s) that recently messaged this phone (the conversation owner).
          const tenantIds = await resolveTenantsForPhone(req.database, clean).catch(() => []);
          for (const tenantId of tenantIds) {
            await recordInbound(req.database, tenantId, clean, at).catch(() => undefined);
          }
        }
      }
    }

    return res.sendStatus(200);
  } catch (e: any) {
    console.warn('[meta-webhook] receive failed:', e?.message || e);
    // Still 200 to avoid Meta retry storms; the error is logged.
    return res.sendStatus(200);
  }
};

export default { metaWebhookVerify, metaWebhookReceive };
