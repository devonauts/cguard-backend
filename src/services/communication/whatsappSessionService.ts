/**
 * whatsappSessionService — owns the Meta WhatsApp 24h customer-service window.
 *
 * Meta only allows free-form (non-template) business messages within 24h of the
 * recipient's last inbound message. We persist that timestamp per (tenant, phone)
 * in whatsappInboundSessions:
 *   - the Meta webhook calls recordInbound() on every inbound message;
 *   - metaWhatsAppProvider calls isWithinWindow() to choose text vs template.
 *
 * Phones are normalized to E.164-ish (leading '+', digits only) so the webhook
 * sender and the provider recipient compare equal regardless of formatting.
 */
import { normalizeToE164 } from './phone';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Upsert lastInboundAt for (tenantId, phone). Best-effort; never throws. */
export async function recordInbound(
  db: any,
  tenantId: string,
  phone: string,
  at: Date = new Date(),
): Promise<void> {
  if (!db?.whatsappInboundSession || !tenantId) return;
  const normalized = normalizeToE164(phone);
  if (!normalized) return;
  try {
    const [row, created] = await db.whatsappInboundSession.findOrCreate({
      where: { tenantId, phone: normalized },
      defaults: { tenantId, phone: normalized, lastInboundAt: at },
    });
    if (!created) await row.update({ lastInboundAt: at });
  } catch (e: any) {
    console.warn('[whatsappSession] recordInbound failed:', e?.message || e);
  }
}

/** lastInboundAt for (tenantId, phone), or null if never. */
export async function getLastInboundAt(
  db: any,
  tenantId: string,
  phone: string,
): Promise<Date | null> {
  if (!db?.whatsappInboundSession || !tenantId) return null;
  const normalized = normalizeToE164(phone);
  if (!normalized) return null;
  try {
    const row = await db.whatsappInboundSession.findOne({
      where: { tenantId, phone: normalized },
    });
    const v = row && (row.lastInboundAt as any);
    return v ? new Date(v) : null;
  } catch (e: any) {
    console.warn('[whatsappSession] getLastInboundAt failed:', e?.message || e);
    return null;
  }
}

/** True when the tenant↔phone WhatsApp conversation is inside Meta's 24h window. */
export async function isWithinWindow(
  db: any,
  tenantId: string,
  phone: string,
  now: Date = new Date(),
): Promise<boolean> {
  const last = await getLastInboundAt(db, tenantId, phone);
  if (!last) return false;
  return now.getTime() - last.getTime() < WINDOW_MS;
}

export default { recordInbound, getLastInboundAt, isWithinWindow, WINDOW_MS };
