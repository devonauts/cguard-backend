/**
 * Single source of truth for the SIGNUP invitation-token lifetime
 * (tenantUsers.invitationTokenExpiresAt).
 *
 * Generous on purpose. Previously the expiry was set in ~10 different code paths
 * with wildly inconsistent windows — 7 days, 24h, and even 1 HOUR (the resend and
 * restore paths). Any invited vigilante/user who completed signup after their
 * (often tiny) window lapsed got rejected with "invalid invitation token". This
 * is that bug's fix: EVERY invite/resend/restore path must use
 * invitationTokenExpiry() so the window is one generous, consistent value.
 *
 * Note: this is intentionally NOT used for the separate short-lived mechanisms —
 * email verification, password reset, or the 6-digit TenantInvitation join code —
 * which have their own (appropriately shorter) lifetimes.
 */
export const INVITATION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Expiry Date for a freshly issued or re-sent signup invitation token. */
export function invitationTokenExpiry(): Date {
  return new Date(Date.now() + INVITATION_TOKEN_TTL_MS);
}
