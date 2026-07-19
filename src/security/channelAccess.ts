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
    if (Array.isArray(r)) r.forEach((x) => push(x));
    else if (typeof r === 'string') r.split(',').forEach((x) => out.push(x.trim()));
    else if (typeof r === 'object') { if (r.name || r.slug || r.id) out.push(String(r.name || r.slug || r.id).trim()); }
    else out.push(String(r).trim());
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

// The three field/external roles. EVERYTHING else — office/admin roles,
// superadmin, and any custom tenant role (slugified name, e.g. 'jefe-de-turno')
// — is CRM-capable. This is the single predictable rule both gates share:
// "you're barred from the CRM iff every role you hold is one of these three."
const FIELD_ONLY = new Set(['securityguard', 'securitysupervisor', 'customer']);

// Which exact role a field app admits.
const APP_REQUIRED_ROLE: Partial<Record<AppChannel, string>> = {
  worker: 'securityguard',
  supervisor: 'securitysupervisor',
  customer: 'customer',
};

/** The channel to point a user at (for the "use the X app" message). Their first
 *  known field role's home, else CRM (office/custom/roleless). */
function homeChannelOf(roles: string[]): AppChannel {
  for (const r of roles) {
    const home = ROLE_HOME_CHANNEL[r];
    if (home) return home;
  }
  return 'web';
}

/**
 * True when the account is barred from the CRM: it holds roles and EVERY one is
 * a field/external role (guard/supervisor/customer). Office roles, custom tenant
 * roles, superadmin, and roleless/lean payloads are NOT field-only (fail-open),
 * so a legit custom-role admin is never booted from the CRM. Kept in lockstep
 * with `assertChannelAllowed(..., 'web')`.
 */
export function isFieldOnlyUser(user: any): boolean {
  const roles = userRoleSlugs(user);
  if (!roles.length) return false;
  if (roles.some(isSuper)) return false;
  return roles.every((r) => FIELD_ONLY.has(r));
}

/**
 * Throw Error403 when `roles` may not sign in through `channel`. Superadmin →
 * allowed everywhere. The CRM (web) admits anyone who is NOT field-only (office,
 * custom, or roleless). A field app admits ONLY its exact role (guard→worker,
 * supervisor→supervisor, customer→customer). Consistent with isFieldOnlyUser.
 */
export function assertChannelAllowed(roles: string[], channel: AppChannel, language?: string): void {
  const lowered = (roles || []).map((r) => String(r).toLowerCase().trim()).filter(Boolean);
  if (lowered.some(isSuper)) return;

  if (channel === 'web') {
    // CRM: allowed unless EVERY role is a field/external role.
    if (lowered.length === 0 || lowered.some((r) => !FIELD_ONLY.has(r))) return;
    throw new Error403(language, HOME_MESSAGE[homeChannelOf(lowered)] || 'auth.channelNotAllowed');
  }

  // Field app: only the exact role for that app may enter (office/custom/roleless
  // are told to use the CRM).
  const need = APP_REQUIRED_ROLE[channel];
  if (need && lowered.includes(need)) return;
  throw new Error403(language, HOME_MESSAGE[homeChannelOf(lowered)] || 'auth.channelNotAllowed');
}
