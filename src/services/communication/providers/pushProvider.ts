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
import { pushToUser, sendToTokens } from '../../pushService';

/** FCM error codes that mean "this token is dead, stop using it". */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** Resolve a user's registered device-token rows (with the row, for cleanup). */
async function resolveTokenRows(
  db: any,
  tenantId: string,
  userId: string,
): Promise<Array<{ token: string; row: any }>> {
  try {
    const rows = await db.deviceIdInformation.findAll({ where: { tenantId, userId } });
    return (rows || [])
      .map((r: any) => ({ token: r.pushToken || r.deviceId, row: r }))
      .filter((x: any) => !!x.token);
  } catch (e: any) {
    console.warn('[pushProvider] token resolve failed:', e?.message || e);
    return [];
  }
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

  async send(db: any, msg: OutboundMessage): Promise<SendResult> {
    const targetUserId = msg.userId || msg.recipient;
    if (!targetUserId) {
      return { status: 'skipped', channel: 'push', provider: 'firebase', skipReason: 'no_user' };
    }

    const data: Record<string, string> = { ...(msg.data || {}) };
    if (msg.deepLink) data.deepLink = msg.deepLink;
    if (msg.messageType) data.messageType = msg.messageType;

    const payload = { title: msg.title || '', body: msg.body || '', data };

    // Resolve tokens ourselves so we can (a) report "no token" precisely and
    // (b) clean up dead tokens after the send.
    const tokenRows = await resolveTokenRows(db, msg.tenantId, targetUserId);
    if (tokenRows.length === 0) {
      // No token: fall back to the legacy wrapper too (it may resolve via other
      // columns / paths) — but if it also has nothing, report skipped.
      try {
        const res: any = await pushToUser(db, msg.tenantId, targetUserId, payload);
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

      // Best-effort dead-token cleanup. sendEachForMulticast surfaces per-token
      // results in `res.responses` (firebase-admin BatchResponse); our wrapper
      // returns successCount/failureCount. When the detailed responses are
      // present, deactivate exactly the dead ones; otherwise, if the whole batch
      // failed with zero successes, deactivate all resolved tokens.
      await this.cleanupDeadTokens(res, tokens, tokenRows);

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

  /** Deactivate tokens FCM reported as dead (best-effort, never throws). */
  private async cleanupDeadTokens(
    res: any,
    tokens: string[],
    tokenRows: Array<{ token: string; row: any }>,
  ): Promise<void> {
    try {
      const byToken = new Map<string, any>();
      for (const tr of tokenRows) if (!byToken.has(tr.token)) byToken.set(tr.token, tr.row);

      const responses: any[] = Array.isArray(res?.responses) ? res.responses : [];
      if (responses.length === tokens.length && responses.length > 0) {
        // Detailed per-token results available — deactivate only the dead ones.
        for (let i = 0; i < responses.length; i += 1) {
          const r = responses[i];
          const code = r?.error?.code;
          if (r && r.success === false && code && DEAD_TOKEN_CODES.has(code)) {
            await deactivateToken(byToken.get(tokens[i]));
          }
        }
        return;
      }

      // No per-token detail: if nothing was sent and nothing was a safe no-op
      // (skipped), treat the tokens as dead and clear them.
      const sent = res?.sent || 0;
      if (sent === 0 && !res?.skipped && (res?.failed || 0) > 0) {
        for (const token of tokens) await deactivateToken(byToken.get(token));
      }
    } catch (e: any) {
      console.warn('[pushProvider] dead-token cleanup failed:', e?.message || e);
    }
  }
}

export const pushProvider = new PushProvider();
export default pushProvider;
