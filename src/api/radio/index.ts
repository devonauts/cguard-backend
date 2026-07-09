/**
 * Radio (LiveKit) — mints a short-lived LiveKit access token so the worker /
 * supervisor / CRM apps can join the tenant's live PTT channel over WebRTC
 * (self-hosted LiveKit SFU at wss://livekit.cguardpro.com). Replaces the old
 * socket.io + μ-law relay: Opus, encrypted (DTLS-SRTP), jitter-buffered.
 *
 * Room = radio:<tenantId>:<channel> — tenant-isolated, and per-channel isolated
 * (the old backend was a single tenant-wide room). Identity = userId. The
 * LiveKit API key/secret NEVER leave the server; the client only gets a scoped JWT.
 * We also return ICE servers pointing at our coturn (time-limited HMAC creds) so
 * guards on locked-down networks still connect.
 *
 * POST /tenant/:tenantId/radio/token   body { channel? }  (auth + tenant membership)
 */
import crypto from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';

function buildIceServers(userId: string): any[] {
  const secret = process.env.LIVEKIT_TURN_SECRET;
  const host = process.env.LIVEKIT_TURN_HOST || 'livekit.cguardpro.com';
  if (!secret) return [];
  // coturn use-auth-secret: username = "<unixExpiry>:<id>", credential = base64(HMAC-SHA1(secret, username))
  const ttlSec = 12 * 3600;
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return [
    {
      urls: [
        `turn:${host}:3478?transport=udp`,
        `turn:${host}:3478?transport=tcp`,
        `turns:${host}:5349?transport=tcp`,
      ],
      username,
      credential,
    },
  ];
}

export default (app) => {
  app.post('/tenant/:tenantId/radio/token', async (req: any, res: any) => {
    try {
      const user = req.currentUser;
      const tenantId = (req.currentTenant && req.currentTenant.id) || req.params.tenantId;
      if (!user || !tenantId) throw new Error401();

      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;
      const url = process.env.LIVEKIT_URL;
      if (!apiKey || !apiSecret || !url) {
        throw new Error400(req.language, 'errors.validation.message'); // LiveKit not configured
      }

      const raw = (req.body?.data?.channel ?? req.body?.channel ?? req.query?.channel ?? 'general');
      const channel = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'general';
      const room = `radio:${tenantId}:${channel}`;

      const name =
        (user.fullName && String(user.fullName).trim()) ||
        [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
        user.email ||
        'Radio';

      // TTL must outlive a full guard shift (up to 12h + relevo margin): the app
      // joins once at clock-in, and livekit-client's own reconnects reuse this
      // same token — a shorter TTL made every late-shift reconnect fail.
      const at = new AccessToken(apiKey, apiSecret, { identity: String(user.id), name, ttl: '14h' });
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
      const token = await at.toJwt();

      await ApiResponseHandler.success(req, res, {
        url,
        token,
        room,
        channel,
        iceServers: buildIceServers(String(user.id)),
      });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
