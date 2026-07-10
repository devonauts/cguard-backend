/**
 * pushProvider — wraps the existing src/services/pushService.ts (Firebase FCM).
 * This is the FREE, always-first channel. NON-BREAKING: it reuses
 * pushService.sendToTokens (the real FCM call) rather than reimplementing FCM,
 * and resolves device tokens from the same deviceIdInformation table the legacy
 * pushToUser uses.
 *
 * recipient semantics for push: OutboundMessage.userId (preferred) or
 * OutboundMessage.recipient holds the target userId — push is token-resolved per
 * user. When no token resolves, returns status 'skipped' so the router can fall
 * through to WhatsApp per the routing rules.
 *
 * Invalid/unregistered tokens: when FCM reports a token as not registered /
 * invalid, we mark it inactive in deviceIdInformation (clear its pushToken) so it
 * stops being resolved. We do NOT auto-fallback on a bad token — that's the
 * router's job per the rules.
 */
import { CommunicationProvider, OutboundMessage, SendResult } from '../types';
import { getUserDeviceRows, pushToUser, sendToTokens } from '../../pushService';

/** FCM error codes that mean "this token is dead, stop using it". */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** Map already-resolved device rows to token rows (with the row, for cleanup). */
function toTokenRows(rows: any[]): Array<{ token: string; row: any }> {
  return (rows || [])
    .map((r: any) => ({ token: r.pushToken || r.deviceId, row: r }))
    .filter((x: any) => !!x.token);
}

/** Mark a single device row inactive (clear its push token) so it stops resolving. */
async function deactivateToken(row: any): Promise<void> {
  try {
    if (row && typeof row.update === 'function') {
      await row.update({ pushToken: null, lastMismatchAt: new Date() });
    }
  } catch (e: any) {
    console.warn('[pushProvider] token deactivate failed:', e?.message || e);
  }
}

export class PushProvider implements CommunicationProvider {
  channel = 'push' as const;

  async isConfigured(_db: any, _tenantId: string): Promise<boolean> {
    // Firebase is configured globally via env (FIREBASE_SERVICE_ACCOUNT). The
    // pushService no-ops safely when absent; treat as "configured" so the router
    // always attempts push first, and we record a skip if there's no token.
    return true;
  }

  async send(db: any, msg: OutboundMessage, deviceRows?: any[]): Promise<SendResult> {
    const targetUserId = msg.userId || msg.recipient;
    if (!targetUserId) {
      return { status: 'skipped', channel: 'push', provider: 'firebase', skipReason: 'no_user' };
    }

    const data: Record<string, string> = { ...(msg.data || {}) };
    if (msg.deepLink) data.deepLink = msg.deepLink;
    if (msg.messageType) data.messageType = msg.messageType;

    const payload = { title: msg.title || '', body: msg.body || '', data };

    // Device rows are resolved ONCE per recipient: the router resolves them up
    // front and threads them here; only resolve ourselves when called directly.
    const rows = deviceRows ?? (await getUserDeviceRows(db, msg.tenantId, targetUserId));
    const tokenRows = toTokenRows(rows);
    if (tokenRows.length === 0) {
      // No FCM-ish token: fall back to the legacy wrapper WITH the rows we
      // already resolved (it can still deliver to APNs-only client devices) —
      // no re-query. If it also delivers nothing, report skipped.
      try {
        const res: any = await pushToUser(db, msg.tenantId, targetUserId, payload, rows);
        const sent = res?.sent || 0;
        if (sent > 0) {
          return { status: 'sent', channel: 'push', provider: 'firebase', providerResponse: res };
        }
      } catch {
        /* fall through to skipped */
      }
      return { status: 'skipped', channel: 'push', provider: 'firebase', skipReason: 'no_token' };
    }

    const tokens = Array.from(new Set(tokenRows.map((t) => t.token)));

    try {
      const res: any = await sendToTokens(tokens, payload);
      const sent = res?.sent || 0;

      // Best-effort dead-token cleanup. sendToTokens returns the per-token
      // outcomes ({ token, success, errorCode }) from sendEachForMulticast, so
      // we deactivate exactly the tokens FCM reported as dead — never live
      // tokens on a transient failure.
      await this.cleanupDeadTokens(res, tokenRows);

      if (sent > 0) {
        return {
          status: 'sent',
          channel: 'push',
          provider: 'firebase',
          providerResponse: { sent, failed: res?.failed ?? 0 },
        };
      }
      return {
        status: 'skipped',
        channel: 'push',
        provider: 'firebase',
        providerResponse: { sent: 0, failed: res?.failed ?? 0, skipped: !!res?.skipped },
        skipReason: res?.skipped ? 'no_token_or_disabled' : 'delivery_failed',
      };
    } catch (e: any) {
      return {
        status: 'failed',
        channel: 'push',
        provider: 'firebase',
        error: e?.message || String(e),
      };
    }
  }

  /** Deactivate exactly the tokens FCM reported as dead (best-effort, never
   *  throws). Consumes the token-keyed `responses` array sendToTokens returns.
   *  When no per-token detail exists (send skipped or threw before FCM
   *  responded) we deliberately deactivate NOTHING — a transient full-batch
   *  failure must never wipe a user's live tokens. */
  private async cleanupDeadTokens(
    res: any,
    tokenRows: Array<{ token: string; row: any }>,
  ): Promise<void> {
    try {
      const responses: any[] = Array.isArray(res?.responses) ? res.responses : [];
      if (!responses.length) return;

      const byToken = new Map<string, any>();
      for (const tr of tokenRows) if (!byToken.has(tr.token)) byToken.set(tr.token, tr.row);

      for (const r of responses) {
        if (r && r.success === false && r.errorCode && DEAD_TOKEN_CODES.has(r.errorCode)) {
          await deactivateToken(byToken.get(r.token));
        }
      }
    } catch (e: any) {
      console.warn('[pushProvider] dead-token cleanup failed:', e?.message || e);
    }
  }
}

export const pushProvider = new PushProvider();
export default pushProvider;
