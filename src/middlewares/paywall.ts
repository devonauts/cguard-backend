/**
 * Subscription paywall. When a tenant's billing is inactive (trial expired,
 * payment past-due, or canceled) we block mutating requests (POST/PUT/PATCH/
 * DELETE) for that tenant — reads stay allowed so they can still see their data
 * and the billing screen, and the billing/payment routes are always allowed so
 * they can pay. Returns `true` (and sends a 402) when the request is blocked.
 *
 * Disable with BILLING_PAYWALL_ENABLED=false.
 */
const BLOCKED_STATUSES = ['trial_expired', 'past_due', 'canceled'];
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

function isSuperadmin(user: any): boolean {
  if (!user) return false;
  const roles = Array.isArray(user.roles) ? user.roles : typeof user.role === 'string' ? [user.role] : [];
  return roles.map((r: any) => String(r).toLowerCase()).some((r: string) => r.includes('superadmin'));
}

export function enforcePaywall(req: any, res: any): boolean {
  if (process.env.BILLING_PAYWALL_ENABLED === 'false') return false;

  const tenant = req.currentTenant;
  if (!tenant) return false;
  if (!BLOCKED_STATUSES.includes(tenant.billingStatus)) return false;

  const method = String(req.method || '').toUpperCase();
  if (!MUTATING.includes(method)) return false; // reads always allowed

  // Always allow subscription/payment routes so the tenant can subscribe.
  const path = String(req.originalUrl || req.path || '');
  if (/\/subscription\//.test(path) || /\/plan\//.test(path)) return false;

  // Don't lock out platform superadmins.
  if (isSuperadmin(req.currentUser)) return false;

  res.status(402).json({
    code: 'subscription_required',
    message: 'Tu suscripción está inactiva. Actívala para continuar usando la plataforma.',
  });
  return true;
}

export default { enforcePaywall };
