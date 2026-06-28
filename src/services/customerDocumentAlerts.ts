/**
 * Feature #20 — Document-expiry alerts (scheduled, best-effort).
 *
 * Once a day, scan every tenant's compliance documents (certifications +
 * insurance policies) and, for each one whose days-to-expiry has just crossed a
 * threshold (30 / 15 / 7 / 1 days), push the tenant's clients an alert via
 * clientNotifyService ("Tu certificación X vence en N días").
 *
 * Anti-spam: because the job runs once per day and daysToExpiry decrements by
 * exactly 1 each day, we fire ONLY when daysToExpiry is EXACTLY one of the
 * thresholds. Each (document, threshold) therefore notifies exactly once over the
 * document's lifetime — no per-day spam and no extra "lastNotified" tracking
 * table needed. (Same once-per-occurrence idea as the Consigna scheduler.)
 *
 * Strictly best-effort: wrapped so a failure for one tenant/doc never aborts the
 * run, and the whole function never throws (the server's runJob wrapper also
 * guards it).
 */
import { notifyClient } from './clientNotifyService';

export const EXPIRY_THRESHOLDS = [30, 15, 7, 1];

/** Whole days from today (UTC) until a YYYY-MM-DD / ISO date. null if unparseable. */
function daysUntil(date: any): number | null {
  if (!date) return null;
  const d = new Date(String(date));
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86400000);
}

const plural = (n: number) => (n === 1 ? 'día' : 'días');

/**
 * Run one pass over all tenants' documents. `db` is a databaseInit() handle.
 * Returns the number of client notifications fired (for logging).
 */
export async function runDocumentExpiryAlerts(db: any): Promise<number> {
  let notified = 0;

  // Collect documents expiring at exactly a threshold, grouped by tenant.
  // tenantId -> [{ kind, name, days }]
  const dueByTenant = new Map<string, { kind: 'certification' | 'insurance'; name: string; days: number }[]>();

  const addDue = (tenantId: string, item: { kind: 'certification' | 'insurance'; name: string; days: number }) => {
    if (!tenantId) return;
    if (!dueByTenant.has(tenantId)) dueByTenant.set(tenantId, []);
    dueByTenant.get(tenantId)!.push(item);
  };

  // ── Certifications ──────────────────────────────────────────────────────────
  try {
    const certs = await db.certification.findAll({
      where: { deletedAt: null },
      attributes: ['id', 'tenantId', 'title', 'code', 'expirationDate'],
    });
    for (const c of certs || []) {
      const days = daysUntil(c.expirationDate);
      if (days == null || !EXPIRY_THRESHOLDS.includes(days)) continue;
      addDue(String(c.tenantId), {
        kind: 'certification',
        name: c.title || c.code || 'certificación',
        days,
      });
    }
  } catch (e: any) {
    console.warn('[docExpiry] certifications scan failed:', e?.message || e);
  }

  // ── Insurance policies ──────────────────────────────────────────────────────
  try {
    const policies = await db.insurance.findAll({
      where: { deletedAt: null },
      attributes: ['id', 'tenantId', 'provider', 'policyNumber', 'validUntil'],
    });
    for (const p of policies || []) {
      const days = daysUntil(p.validUntil);
      if (days == null || !EXPIRY_THRESHOLDS.includes(days)) continue;
      const name =
        [p.provider, p.policyNumber].filter(Boolean).join(' ') || 'póliza de seguro';
      addDue(String(p.tenantId), { kind: 'insurance', name, days });
    }
  } catch (e: any) {
    console.warn('[docExpiry] insurance scan failed:', e?.message || e);
  }

  if (!dueByTenant.size) return 0;

  // ── Notify each tenant's clients ────────────────────────────────────────────
  for (const [tenantId, items] of dueByTenant) {
    try {
      const clients = await db.clientAccount.findAll({
        where: { tenantId, deletedAt: null },
        attributes: ['id'],
      });
      const clientIds = (clients || []).map((c: any) => String(c.id)).filter(Boolean);
      if (!clientIds.length) continue;

      for (const item of items) {
        const label = item.kind === 'certification' ? 'certificación' : 'póliza';
        const title = 'Documento por vencer';
        const body = `Tu ${label} "${item.name}" vence en ${item.days} ${plural(item.days)}.`;
        for (const clientAccountId of clientIds) {
          try {
            const n = await notifyClient(
              db,
              tenantId,
              { clientAccountId },
              {
                eventType: 'document.expiring',
                title,
                body,
                data: {
                  type: 'document.expiring',
                  kind: item.kind,
                  daysToExpiry: String(item.days),
                },
                sourceEntityType: 'document',
              },
            );
            if (n) notified += 1;
          } catch { /* per-client best-effort */ }
        }
      }
    } catch (e: any) {
      console.warn('[docExpiry] tenant notify failed:', e?.message || e);
    }
  }

  if (notified) console.log(`[docExpiry] sent ${notified} expiry alert(s)`);
  return notified;
}
