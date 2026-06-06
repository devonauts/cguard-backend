/**
 * Subscription service — trial state, seat counting and the price summary that
 * drives the billing UI and the Stripe checkout for the per-user plan.
 * Pricing math lives in src/lib/billingModel.ts.
 *
 * (Distinct from billingService.ts, which is the customer-invoicing feature.)
 */
import { quote, trialDays, BillingQuote } from '../lib/billingModel';

/** Every tenant user is one billable seat (guard, supervisor, assistant, cliente). */
export async function countBillableSeats(db: any, tenantId: string): Promise<number> {
  try {
    return await db.tenantUser.count({ where: { tenantId } });
  } catch {
    return 0;
  }
}

export interface TrialInfo {
  endsAt: string | null;
  daysLeft: number;
  active: boolean;
  expired: boolean;
}

export function trialInfo(tenant: any): TrialInfo {
  const status = tenant?.billingStatus || 'trialing';
  const endsAtRaw = tenant?.trialEndsAt
    ? new Date(tenant.trialEndsAt)
    : tenant?.createdAt
      ? new Date(new Date(tenant.createdAt).getTime() + trialDays() * 86400000)
      : null;
  const now = Date.now();
  const msLeft = endsAtRaw ? endsAtRaw.getTime() - now : 0;
  const daysLeft = endsAtRaw ? Math.max(0, Math.ceil(msLeft / 86400000)) : 0;
  const onTrial = status === 'trialing';
  return {
    endsAt: endsAtRaw ? endsAtRaw.toISOString() : null,
    daysLeft,
    active: onTrial && msLeft > 0,
    expired: onTrial && msLeft <= 0,
  };
}

export interface BillingSummary {
  status: string; // trialing | active | past_due | trial_expired | canceled
  trial: TrialInfo;
  seats: number;
  implementationPaid: boolean;
  hasSubscription: boolean;
  quote: BillingQuote;
  trialDays: number;
}

export async function getSummary(db: any, tenant: any): Promise<BillingSummary> {
  const seats = await countBillableSeats(db, tenant.id);
  const implementationPaid = !!tenant.implementationPaidAt;
  const q = quote(seats, !implementationPaid);
  return {
    status: tenant.billingStatus || 'trialing',
    trial: trialInfo(tenant),
    seats,
    implementationPaid,
    hasSubscription: !!tenant.stripeSubscriptionId,
    quote: q,
    trialDays: trialDays(),
  };
}
