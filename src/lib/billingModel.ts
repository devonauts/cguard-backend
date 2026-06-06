/**
 * Billing model — single source of truth for the platform's per-user pricing.
 *
 * Business model:
 *   - 14-day free trial, no credit card.
 *   - Then: $250 one-time implementation fee + $5 / user / month, billed monthly.
 *   - Any tenant user (guard, supervisor, assistant, cliente) is one $5 seat.
 *   - Stripe processing fees are passed to the tenant: prices are grossed up so
 *     the platform NETS the target amounts after Stripe takes its cut.
 *
 * Gross-up: stripe charges `pct * gross + fixed` per invoice. To net `target`:
 *     gross = (target + fixedShare) / (1 - pct)
 * The fixed fee ($0.30) is per-invoice, so it's recovered ONCE via a flat
 * "platform processing" line, while the per-seat price recovers only the %.
 *
 * Everything is env-configurable (Ecuador/international cards are often
 * 4.4% + $0.30, so tune STRIPE_FEE_* per your Stripe account).
 */

function num(envVal: string | undefined, fallback: number): number {
  const n = parseFloat(envVal || '');
  return Number.isFinite(n) ? n : fallback;
}
function int(envVal: string | undefined, fallback: number): number {
  const n = parseInt(envVal || '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Stripe percentage fee, as a fraction (0.029 = 2.9%). */
export function feePct(): number {
  return num(process.env.STRIPE_FEE_PERCENT, 0.029);
}
/** Stripe fixed fee per successful charge, in cents. */
export function feeFixedCents(): number {
  return int(process.env.STRIPE_FEE_FIXED_CENTS, 30);
}
/** Target NET revenue per user per month, in cents. */
export function netPerUserCents(): number {
  return int(process.env.BILLING_NET_PER_USER_CENTS, 500);
}
/** Target NET implementation (one-time) fee, in cents. */
export function netImplementationCents(): number {
  return int(process.env.BILLING_NET_IMPLEMENTATION_CENTS, 25000);
}
/** Free-trial length in days. */
export function trialDays(): number {
  return int(process.env.BILLING_TRIAL_DAYS, 14);
}

/** Gross a net amount up so the platform keeps `netCents` after the % fee. */
export function grossUpPercent(netCents: number): number {
  return Math.ceil(netCents / (1 - feePct()));
}

/** Grossed per-seat monthly price (recovers the % fee). e.g. 500 → 515. */
export function grossPerUserCents(): number {
  return grossUpPercent(netPerUserCents());
}
/** Flat per-invoice processing line that recovers the fixed fee. e.g. 30 → 31. */
export function platformFeeCents(): number {
  return grossUpPercent(feeFixedCents());
}
/** Grossed one-time implementation fee. e.g. 25000 → 25747. */
export function grossImplementationCents(): number {
  return grossUpPercent(netImplementationCents());
}

export interface BillingQuote {
  seats: number;
  perUserCents: number;
  platformFeeCents: number;
  monthlyCents: number;
  implementationCents: number;
  firstChargeCents: number;
  currency: string;
  /** What the platform actually keeps after Stripe fees, for transparency. */
  netMonthlyCents: number;
}

/** Compute a price quote for `seats` users. */
export function quote(seats: number, includeImplementation: boolean): BillingQuote {
  const s = Math.max(0, Math.floor(seats || 0));
  const perUser = grossPerUserCents();
  const platform = platformFeeCents();
  const monthly = perUser * s + platform;
  const impl = includeImplementation ? grossImplementationCents() : 0;
  // Net the platform keeps from the monthly recurring charge.
  const netMonthly = Math.round(monthly * (1 - feePct()) - feeFixedCents());
  return {
    seats: s,
    perUserCents: perUser,
    platformFeeCents: platform,
    monthlyCents: monthly,
    implementationCents: impl,
    firstChargeCents: monthly + impl,
    currency: 'USD',
    netMonthlyCents: netMonthly,
  };
}
