/**
 * rechargeReconciliation — safety net for MISSED Stripe recharge webhooks.
 *
 * If the webhook endpoint/secret is misconfigured (or Stripe retries exhaust),
 * a tenant pays for a wallet top-up that never lands. This sweep lists the
 * platform's Stripe checkout sessions from the last 48h, picks the PAID ones
 * whose metadata.purpose is a wallet recharge ('communications_recharge', or
 * the retired 'sms_recharge' for in-flight sessions) and credits them through
 * creditWalletFromRecharge — whose reference=session.id dedupe (under the
 * wallet row lock) makes re-crediting an already-received webhook a no-op.
 *
 * Never throws — scheduled via runJob('RechargeReconciliation') in server.ts
 * (leader-gated, every 6h + ~2min after boot).
 */
import { getStripeClient } from '../stripe/stripeConfigService';
import { creditWalletFromRecharge } from './communicationSettingsService';

const RECHARGE_PURPOSES = new Set(['communications_recharge', 'sms_recharge']);
const LOOKBACK_HOURS = 48;
const MAX_PAGES = 10; // 10 × 100 sessions — far beyond a realistic 48h volume

export interface ReconcileResult {
  scanned: number;
  matched: number;
  credited: number;
}

export async function reconcileRechargeSessions(db: any): Promise<ReconcileResult> {
  const out: ReconcileResult = { scanned: 0, matched: 0, credited: 0 };
  try {
    const stripe = await getStripeClient(db);
    if (!stripe) return out; // Stripe not configured — nothing to reconcile.

    const createdGte = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await stripe.checkout.sessions.list({
        limit: 100,
        created: { gte: createdGte },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const sessions = (res && res.data) || [];
      if (!sessions.length) break;

      for (const session of sessions) {
        out.scanned += 1;
        const purpose = session?.metadata?.purpose;
        if (!purpose || !RECHARGE_PURPOSES.has(purpose)) continue;
        if (session.payment_status !== 'paid') continue;

        const tenantId = session.metadata?.tenantId;
        const amountCents =
          Number(session.metadata?.amountCents) || Number(session.amount_total) || 0;
        if (!tenantId || !(amountCents > 0)) continue;
        out.matched += 1;

        try {
          const r = await creditWalletFromRecharge(db, tenantId, amountCents, {
            reference: session.id,
            description:
              purpose === 'sms_recharge'
                ? 'Recarga de saldo SMS (Stripe, reconciliación)'
                : 'Recarga de saldo de comunicaciones (Stripe, reconciliación)',
            currency: (session.currency || 'usd').toUpperCase(),
          });
          if (r.ok && !r.duplicated) {
            out.credited += 1;
            console.log(
              `[RechargeReconciliation] credited MISSED recharge tenant=${tenantId} cents=${amountCents} session=${session.id} (webhook never landed)`,
            );
          }
        } catch (e: any) {
          console.error(
            `[RechargeReconciliation] credit failed tenant=${tenantId} session=${session.id}:`,
            e?.message || e,
          );
        }
      }

      if (!res.has_more) break;
      startingAfter = sessions[sessions.length - 1].id;
    }
  } catch (e: any) {
    console.error('[RechargeReconciliation] sweep failed:', e?.message || e);
  }
  return out;
}

export default { reconcileRechargeSessions };
