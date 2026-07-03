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

export interface BillableUser {
  id: string;
  name: string;
  email: string | null;
  roles: string[];
  status: string | null;
}

/**
 * The billable users for a tenant — exactly the rows counted by
 * countBillableSeats, with identity from the linked user. Powers the
 * "active users" list on the billing screen so the customer can see who
 * they are paying for.
 */
export async function listBillableUsers(db: any, tenantId: string): Promise<BillableUser[]> {
  try {
    const rows = await db.tenantUser.findAll({
      where: { tenantId },
      include: [{ model: db.user, attributes: ['id', 'firstName', 'lastName', 'email'] }],
      order: [['createdAt', 'ASC']],
    });
    return rows.map((tu: any) => {
      const u = tu.user || {};
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      let roles: string[] = [];
      const raw = tu.roles;
      if (Array.isArray(raw)) roles = raw;
      else if (typeof raw === 'string') {
        try { roles = JSON.parse(raw); } catch { roles = []; }
      }
      return {
        id: tu.id,
        name: name || u.email || '—',
        email: u.email || null,
        roles,
        status: tu.status || null,
      };
    });
  } catch {
    return [];
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
  // Plan-catalog resolution (fail-open: all features / unlimited when unset).
  plan: {
    key: string | null;
    name: string | null;
    features: string[];
    seatCap: number | null;
    seatsRemaining: number | null; // null = unlimited
    overLimit: boolean;
  };
}

export async function getSummary(db: any, tenant: any): Promise<BillingSummary> {
  const seats = await countBillableSeats(db, tenant.id);
  const implementationPaid = !!tenant.implementationPaidAt;

  // Resolve tier entitlements + pricing overrides (fail-open on any error).
  let resolved: any = null;
  let pricing: any = null;
  try {
    const svc = require('./planCatalogService');
    resolved = await svc.resolveForTenant(db, tenant);
    pricing = await svc.resolvePricing(db, tenant);
  } catch {
    resolved = null;
    pricing = null;
  }

  const q = quote(
    seats,
    !implementationPaid,
    pricing ? { perUserCents: pricing.perSeatCents, implementationCents: pricing.implementationCents } : undefined,
  );

  const seatCap = resolved?.seatCap ?? null;
  const seatsRemaining = seatCap == null ? null : Math.max(0, seatCap - seats);

  return {
    status: tenant.billingStatus || 'trialing',
    trial: trialInfo(tenant),
    seats,
    implementationPaid,
    hasSubscription: !!tenant.stripeSubscriptionId,
    quote: q,
    trialDays: trialDays(),
    plan: {
      key: resolved?.planKey ?? (tenant.plan || null),
      name: resolved?.planName ?? null,
      features: resolved?.features ?? [],
      seatCap,
      seatsRemaining,
      overLimit: seatCap != null && seats > seatCap,
    },
  };
}
