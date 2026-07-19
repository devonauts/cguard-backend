import Error403 from '../errors/Error403';

/**
 * Channel ↔ role access control.
 *
 * Each account may only sign in through the channel(s) its role(s) map to:
 *   web (CRM)   → office/admin roles
 *   worker      → securityGuard (guard app)
 *   supervisor  → securitySupervisor (supervisor app)
 *   customer    → customer (Mi Seguridad portal)
 *
 * superadmin is a cross-cutting exception (allowed everywhere). A user with
 * MULTIPLE roles is allowed on a channel iff ANY of their roles maps to it
 * (a guard who is also an office admin keeps CRM access). A user with NO role
 * may only use the CRM (harmless restricted dashboard), never a field/customer app.
 *
 * This is the single source of truth consumed by /auth/sign-in, social login,
 * and the per-request /auth/me gate.
 */

export type AppChannel = 'web' | 'worker' | 'supervisor' | 'customer';

// Role slug (lowercased) → its home channel.
const ROLE_HOME_CHANNEL: Record<string, AppChannel> = {
  // Office / administrative → CRM
  admin: 'web',
  operationsmanager: 'web',
  hrmanager: 'web',
  clientaccountmanager: 'web',
  dispatcher: 'web',
  administrativesupervisor: 'web',
  administrativeassistant: 'web',
  secretary: 'web',
  custom: 'web', // configurable role — provisioned by office admins, defaults to CRM
  // Field / external
  securityguard: 'worker',
  securitysupervisor: 'supervisor',
  customer: 'customer',
};

const HOME_MESSAGE: Record<AppChannel, string> = {
  web: 'auth.mustUseCrm',
  worker: 'auth.mustUseWorkerApp',
  supervisor: 'auth.mustUseSupervisorApp',
  customer: 'auth.mustUseCustomerApp',
};

const isSuper = (r: string) => r === 'superadmin' || r === 'super_admin';

export function normalizeAppChannel(raw: unknown): AppChannel {
  const v = String(raw || '').toLowerCase();
  return v === 'worker' || v === 'supervisor' || v === 'customer' ? v : 'web';
}

/** Collect every role slug (lowercased) an authenticated user holds, across the
 *  selected tenant, the flattened tenants array, and any top-level roles. */
export function userRoleSlugs(user: any): string[] {
  const out: string[] = [];
  const push = (r: any) => {
    if (!r) return;
    if (Array.isArray(r)) r.forEach((x) => out.push(String(x)));
    else if (typeof r === 'string') r.split(',').forEach((x) => out.push(x.trim()));
    else if (typeof r === 'object' && (r.name || r.slug || r.id)) out.push(String(r.name || r.slug || r.id));
  };
  push(user?.tenant?.roles ?? user?.tenant?.role);
  if (Array.isArray(user?.tenants)) user.tenants.forEach((t: any) => push(t?.roles ?? t?.role));
  push(user?.roles ?? user?.role);
  if (user?.isSuperadmin) out.push('superadmin');
  return out.map((r) => r.toLowerCase()).filter(Boolean);
}

export function hasSuperadminRole(user: any): boolean {
  return userRoleSlugs(user).some(isSuper);
}

/** The set of channels this set of role slugs may sign in through. */
function allowedChannels(roles: string[]): Set<AppChannel> {
  const set = new Set<AppChannel>();
  for (const r of roles) {
    const home = ROLE_HOME_CHANNEL[r];
    if (home) set.add(home);
  }
  return set;
}

/**
 * True when the account holds NO office/CRM role → must never use the CRM.
 * (A guard/supervisor/customer, or any purely field/external account.)
 * Returns false for superadmin and for roleless/lean payloads (fail-open there;
 * the CRM's roleless dashboard is harmless and login-time gating covers signup).
 */
export function isFieldOnlyUser(user: any): boolean {
  const roles = userRoleSlugs(user);
  if (!roles.length) return false;
  if (roles.some(isSuper)) return false;
  return !allowedChannels(roles).has('web');
}

/**
 * Throw Error403 when `roles` may not sign in through `channel`. Used at every
 * session-minting front (sign-in, social). Superadmin → allowed everywhere;
 * roleless → web only; otherwise union-of-home-channels must include `channel`.
 */
export function assertChannelAllowed(roles: string[], channel: AppChannel, language?: string): void {
  const lowered = (roles || []).map((r) => String(r).toLowerCase()).filter(Boolean);
  if (lowered.some(isSuper)) return;

  const allowed = allowedChannels(lowered);
  if (allowed.size === 0) {
    if (channel === 'web') return; // roleless account → CRM only
    throw new Error403(language, 'auth.channelNotAllowed');
  }
  if (allowed.has(channel)) return;

  // Point them at where they SHOULD sign in.
  const home = Array.from(allowed)[0];
  throw new Error403(language, HOME_MESSAGE[home] || 'auth.channelNotAllowed');
}
