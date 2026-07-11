/**
 * Single active session PER APP CHANNEL for user accounts (seat enforcement).
 *
 * Seats are billed per user account, so one account shared across several
 * devices dodges licensing (and confuses attendance/radio/etc.). Model:
 *   - Every sign-in mints a session id (`sid`) tagged with the app channel
 *     (`ch`: web | worker | supervisor) and stores it in
 *     users.activeSessionIds (JSON: channel → sid).
 *   - findByToken rejects a token whose sid no longer matches its channel's
 *     active sid → 401 auth.sessionSuperseded → the old device lands on login.
 *   - Channels are independent: CRM web + the mobile app can coexist for the
 *     same person; a SECOND device on the same channel kicks the first.
 *
 * Enforcement is gated by ENFORCE_SINGLE_SESSION=true (kill-switch); session
 * ids are minted/rotated regardless so the flag can be flipped on later and
 * bite immediately. Tokens issued before this feature carry no sid/ch and are
 * grandfathered until they expire or the user signs in again.
 *
 * Exemptions:
 *   - Demo-tenant accounts (@demo.cguardpro.com) — shared by design for sales
 *     demos (the original account-wide version of this feature was disabled
 *     precisely because it kicked demo/shared logins).
 *   - Accounts with the superadmin role — platform staff, not tenant seats
 *     (checked at enforcement time in findByToken).
 *
 * The customer app has its own equivalent (clientAccount.activeSessionId,
 * enforced in authMiddleware) — untouched by this module.
 */
import crypto from 'crypto';

export type SessionChannel = 'web' | 'worker' | 'supervisor';

const CHANNELS: SessionChannel[] = ['web', 'worker', 'supervisor'];

export function singleSessionEnabled(): boolean {
  return String(process.env.ENFORCE_SINGLE_SESSION || '').toLowerCase() === 'true';
}

/** Sanitize the client-provided app identifier; unknown/absent → 'web'. */
export function normalizeChannel(raw: unknown): SessionChannel {
  const v = String(raw || '').toLowerCase();
  return (CHANNELS as string[]).includes(v) ? (v as SessionChannel) : 'web';
}

/** Demo-tenant logins are shared by design (sales demos) — never supersede them. */
export function isSessionExemptEmail(email: unknown): boolean {
  return String(email || '').toLowerCase().endsWith('@demo.cguardpro.com');
}

/** Does this (fully loaded) user hold the superadmin role in any tenant? */
export function hasSuperadminRole(user: any): boolean {
  try {
    const tenants = Array.isArray(user?.tenants) ? user.tenants : [];
    return tenants.some((te: any) => {
      const roles = Array.isArray(te?.roles) ? te.roles : [];
      return roles.some((r: any) => {
        const n = String(r).toLowerCase();
        return n === 'superadmin' || n === 'super_admin';
      });
    });
  } catch {
    return false;
  }
}

export function parseActiveSessions(raw: unknown): Record<string, string> {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Mint a new session id for (user, channel) and persist it as the channel's
 * active session. Returns the JWT claims to embed ({ sid, ch }), or {} for
 * exempt accounts. Call inside the sign-in transaction.
 */
export async function mintSessionClaims(
  database: any,
  user: { id: string; email?: string },
  channel: SessionChannel,
  transaction?: any,
): Promise<{ sid?: string; ch?: SessionChannel }> {
  if (isSessionExemptEmail(user.email)) return {};

  const sid = crypto.randomUUID();
  const row = await database.user.findByPk(user.id, {
    attributes: ['id', 'activeSessionIds'],
    transaction,
  });
  const sessions = parseActiveSessions(row?.activeSessionIds);
  sessions[channel] = sid;
  await database.user.update(
    { activeSessionIds: JSON.stringify(sessions) },
    { where: { id: user.id }, transaction },
  );
  return { sid, ch: channel };
}
