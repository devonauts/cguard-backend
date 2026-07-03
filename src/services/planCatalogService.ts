/**
 * Plan catalog service — reads the editable tier catalog (planCatalogs) and
 * resolves a tenant's effective entitlements, seat cap and pricing.
 *
 * FAIL OPEN: if the catalog is empty or a tenant's plan has no matching row, the
 * tenant gets ALL features and an unlimited seat cap, and pricing falls back to
 * the flat billingModel defaults. Enabling the catalog therefore never removes
 * access until a superadmin deliberately narrows a tier.
 *
 * A short in-memory cache avoids a DB hit per request (the catalog changes
 * rarely). Mutations call clearCache().
 */
import { ALL_FEATURE_KEYS, sanitizeFeatures } from '../lib/entitlements';
import { grossPerUserCents, grossImplementationCents, netPerUserCents, netImplementationCents } from '../lib/billingModel';

export interface ResolvedPlan {
  planKey: string | null;
  planName: string | null;
  features: string[];      // resolved entitlement keys (all keys if fail-open)
  seatCap: number | null;  // null = unlimited
  monthlyPerSeatCents: number | null; // null = billingModel default
  implementationCents: number | null; // null = billingModel default
  stripePriceId: string | null;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: any[] } | null = null;

/** Clear the catalog cache (call after any catalog mutation). */
export function clearCache(): void {
  cache = null;
}

/** All catalog rows (plain objects), cached. Best-effort — returns [] on error. */
export async function getCatalog(db: any): Promise<any[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  try {
    const rows = await db.planCatalog.findAll({ order: [['sortOrder', 'ASC']] });
    const plain = rows.map((r: any) => (r.get ? r.get({ plain: true }) : r));
    cache = { at: now, rows: plain };
    return plain;
  } catch {
    return cache?.rows || [];
  }
}

export async function getPlanByKey(db: any, key: string): Promise<any | null> {
  if (!key) return null;
  const rows = await getCatalog(db);
  return rows.find((r) => r.key === key) || null;
}

/** The tier new self-signup tenants should land on (isDefault, else 'free'). */
export async function getDefaultPlanKey(db: any): Promise<string> {
  const rows = await getCatalog(db);
  const def = rows.find((r) => r.isDefault && r.active);
  return def?.key || 'free';
}

/**
 * Resolve a tenant's effective plan. Fail-open when no catalog row matches so
 * existing tenants never lose access.
 */
export async function resolveForTenant(db: any, tenant: any): Promise<ResolvedPlan> {
  const planKey = tenant?.plan || null;
  const row = planKey ? await getPlanByKey(db, planKey) : null;

  if (!row) {
    return {
      planKey,
      planName: null,
      features: ALL_FEATURE_KEYS,
      seatCap: null,
      monthlyPerSeatCents: null,
      implementationCents: null,
      stripePriceId: null,
    };
  }

  const features = sanitizeFeatures(row.features);
  return {
    planKey: row.key,
    planName: row.name,
    // Empty feature list on a tier = "all features" (fail open).
    features: features.length ? features : ALL_FEATURE_KEYS,
    seatCap: row.seatCap == null ? null : Number(row.seatCap),
    monthlyPerSeatCents: row.monthlyPerSeatCents == null ? null : Number(row.monthlyPerSeatCents),
    implementationCents: row.implementationCents == null ? null : Number(row.implementationCents),
    stripePriceId: row.stripePriceId || null,
  };
}

/**
 * Effective GROSS per-seat + implementation cents for a tenant, honoring tier
 * overrides. A tier price is stored/entered as a NET target (what the platform
 * keeps) for consistency with billingModel, then grossed up the same way.
 */
export async function resolvePricing(
  db: any,
  tenant: any,
): Promise<{ perSeatCents: number; implementationCents: number }> {
  const resolved = await resolveForTenant(db, tenant);
  const { grossUpPercent } = require('../lib/billingModel');
  const perSeat = resolved.monthlyPerSeatCents != null
    ? grossUpPercent(resolved.monthlyPerSeatCents)
    : grossPerUserCents();
  const impl = resolved.implementationCents != null
    ? grossUpPercent(resolved.implementationCents)
    : grossImplementationCents();
  return { perSeatCents: perSeat, implementationCents: impl };
}

export default { getCatalog, getPlanByKey, getDefaultPlanKey, resolveForTenant, resolvePricing, clearCache };
