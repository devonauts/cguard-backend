/**
 * Subscription paywall — tiered enforcement of a tenant's billing state.
 *
 * The enforcement is deliberately graduated so a lapse never strands field
 * operations harder than the situation warrants:
 *
 *   trialing      → full access (a banner nudges them in the CRM).
 *   trial_expired → block ALL writes (402). They never paid, so we're strict;
 *                   reads stay open so they can see their data + the billing page.
 *   past_due      → a PAYING customer whose card just failed. Keep field/mobile
 *                   operations flowing (guard clock-ins, incidents, scans, …) and
 *                   only block clearly-administrative writes (settings, users,
 *                   roles, imports, invoicing) as a nudge. Reads stay open.
 *   canceled      → HARD block: reads AND writes get 403. Subscription/plan
 *                   routes stay open so they can re-subscribe self-serve.
 *   suspended     → HARD block: everything 403 (superadmin lever). Login is also
 *                   blocked upstream in authService, so a suspended tenant can't
 *                   even establish a session.
 *
 * Trial-lag safety net: the 6-hourly cron is what flips trialing → trial_expired,
 * so between the trial actually ending and the next cron tick a tenant's stored
 * billingStatus is still 'trialing'. We compute expiry LIVE here off trialEndsAt
 * so writes are blocked the moment the trial lapses, not up to 6h later.
 *
 * Returns `true` (and sends the response) when the request is blocked.
 * Disable ALL enforcement with BILLING_PAYWALL_ENABLED=false.
 */
import { trialInfo } from '../services/subscriptionService';

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Clearly-administrative write surfaces that are blocked under `past_due`. The
 * bias for past_due (a paying customer) is allow-by-default so we never strand
 * field ops; only these admin/config surfaces get blocked as a payment nudge.
 */
const ADMIN_WRITE_PATTERNS: RegExp[] = [
  /\/settings?(\/|$)/i,
  /\/user(s)?(\/|$)/i,
  /\/role(s)?(\/|$)/i,
  /\/permission/i,
  /\/import/i,
  /\/invoice/i,
  /\/estimate/i,
  /\/presupuesto/i,
  /\/billing(\/|$)/i,
];

function isSuperadmin(user: any): boolean {
  if (!user) return false;
  const roles = Array.isArray(user.roles) ? user.roles : typeof user.role === 'string' ? [user.role] : [];
  return roles.map((r: any) => String(r).toLowerCase()).some((r: string) => r.includes('superadmin'));
}

/** Subscription/plan routes are always reachable so a tenant can pay/re-subscribe. */
function isBillingRoute(path: string): boolean {
  return /\/subscription\//.test(path) || /\/plan\//.test(path);
}

/**
 * The effective billing status, resolving a still-'trialing' tenant whose trial
 * end date has passed to 'trial_expired' (closes the up-to-6h cron lag).
 */
function effectiveStatus(tenant: any): string {
  const status = tenant.billingStatus || 'trialing';
  if (status === 'trialing') {
    const info = trialInfo(tenant);
    if (info.expired) return 'trial_expired';
  }
  return status;
}

export function enforcePaywall(req: any, res: any): boolean {
  if (process.env.BILLING_PAYWALL_ENABLED === 'false') return false;

  const tenant = req.currentTenant;
  if (!tenant) return false;

  // Platform superadmins are never paywalled.
  if (isSuperadmin(req.currentUser)) return false;

  const method = String(req.method || '').toUpperCase();
  const isWrite = MUTATING.includes(method);
  const path = String(req.originalUrl || req.path || '');

  // ── Hard block: suspended (superadmin lever) ───────────────────────────────
  // Blocks reads AND writes; no billing-route exception (a suspension is an
  // administrative hold, resolved by a superadmin, not by paying).
  if (tenant.suspendedAt) {
    res.status(403).json({
      code: 'tenant_suspended',
      message: 'Tu cuenta está suspendida. Contacta a soporte para reactivarla.',
    });
    return true;
  }

  const status = effectiveStatus(tenant);

  // ── Hard block: canceled ───────────────────────────────────────────────────
  // Blocks reads AND writes, EXCEPT subscription/plan routes so they can
  // re-subscribe self-serve.
  if (status === 'canceled') {
    if (isBillingRoute(path)) return false;
    res.status(403).json({
      code: 'subscription_canceled',
      message: 'Tu suscripción fue cancelada. Actívala nuevamente para continuar.',
    });
    return true;
  }

  // Everything below only gates writes; reads stay open.
  if (!isWrite) return false;
  if (isBillingRoute(path)) return false; // always allow paying

  // ── Soft block: trial_expired → block ALL writes ───────────────────────────
  if (status === 'trial_expired') {
    res.status(402).json({
      code: 'subscription_required',
      message: 'Tu prueba gratuita terminó. Activa tu suscripción para continuar.',
    });
    return true;
  }

  // ── Soft block: past_due → block only administrative writes ────────────────
  if (status === 'past_due') {
    const isAdminWrite = ADMIN_WRITE_PATTERNS.some((re) => re.test(path));
    if (!isAdminWrite) return false; // operational writes flow
    res.status(402).json({
      code: 'payment_past_due',
      message: 'Tu último pago falló. Actualiza tu método de pago para seguir administrando la cuenta.',
    });
    return true;
  }

  // trialing / active → allow.
  return false;
}

export default { enforcePaywall };
