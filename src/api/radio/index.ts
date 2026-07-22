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

      // Radio roster label = FIRST NAME + nominativo, e.g. "David (Administración)"
      // or "Juan (Garita 1)". Full names crowd the channel and read like a
      // directory; on the air you want who + where. The nominativo is the
      // station call-sign (station.nickname, falling back to its name) for guards
      // on post, and "Administración" for office/admin/dispatch.
      const fullName =
        (user.fullName && String(user.fullName).trim()) ||
        [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
        '';
      const first =
        (user.firstName && String(user.firstName).trim()) ||
        (fullName ? fullName.split(/\s+/)[0] : '') ||
        (user.email ? String(user.email).split('@')[0] : '') ||
        'Radio';

      let nominativo = 'Administración';
      try {
        const tenantRec = (Array.isArray(user.tenants) ? user.tenants : []).find(
          (t: any) => t && t.tenant && String(t.tenant.id) === String(tenantId) && t.status === 'active',
        );
        const roles: string[] = Array.isArray(tenantRec?.roles)
          ? tenantRec.roles
          : (tenantRec?.roles ? [tenantRec.roles] : []);
        // A vigilante on post is labelled by their station; everyone else
        // (admin, dispatcher, office, supervisor) is "Administración".
        if (roles.includes('securityGuard')) {
          const sg = await req.database.securityGuard.findOne({
            where: { guardId: user.id, tenantId, deletedAt: null },
            attributes: ['id'],
          });
          let stationId: string | null = null;
          if (sg) {
            // Prefer the station they're CLOCKED IN at (radio joins at clock-in);
            // fall back to their active assignment's station.
            const gs = await req.database.guardShift.findOne({
              where: { guardNameId: sg.id, tenantId, punchOutTime: null, deletedAt: null },
              attributes: ['stationNameId'],
              order: [['punchInTime', 'DESC']],
            });
            stationId = (gs && gs.stationNameId) || null;
          }
          if (!stationId) {
            const ga = await req.database.guardAssignment.findOne({
              where: { guardId: user.id, tenantId, status: 'active', deletedAt: null },
              attributes: ['stationId'],
            });
            stationId = (ga && ga.stationId) || null;
          }
          if (stationId) {
            const st = await req.database.station.findByPk(stationId, {
              attributes: ['nickname', 'stationName'],
            });
            nominativo =
              (st && st.nickname && String(st.nickname).trim()) ||
              (st && st.stationName && String(st.stationName).trim()) ||
              'Puesto';
          } else {
            nominativo = 'Puesto';
          }
        }
      } catch { /* keep 'Administración' fallback */ }

      const name = `${first} (${nominativo})`;

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

  /**
   * POST /tenant/:tenantId/radio/transmission  body { channel?, durationMs }
   *
   * Audit trail for PTT: the app reports each finished transmission (LiveKit
   * itself keeps no per-transmission record). Stored as a platform event so it
   * lands in the CRM's event stream alongside checkins/incidents/rondas.
   */
  app.post('/tenant/:tenantId/radio/transmission', async (req: any, res: any) => {
    try {
      const user = req.currentUser;
      const tenantId = (req.currentTenant && req.currentTenant.id) || req.params.tenantId;
      if (!user || !tenantId) throw new Error401();
      const body = req.body?.data || req.body || {};
      const channel = String(body.channel || 'general').slice(0, 60);
      const durationMs = Math.max(0, Math.min(10 * 60_000, Number(body.durationMs) || 0));
      const secs = Math.max(1, Math.round(durationMs / 1000));
      let name = 'Radio';
      try {
        const sg = await req.database.securityGuard.findOne({
          where: { guardId: user.id, tenantId, deletedAt: null },
          attributes: ['fullName'],
        });
        name = (sg && sg.fullName) || user.fullName || 'Radio';
      } catch { /* keep fallback */ }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { storePlatformEvent } = require('../../lib/platformEventStore');
      await storePlatformEvent(req.database, {
        tenantId,
        eventType: 'radio.transmission',
        title: 'Transmisión de radio',
        body: `${name} transmitió ${secs}s en el canal ${channel}`,
        payload: { userId: String(user.id), channel, durationMs },
        sourceEntityType: 'radio',
        sourceEntityId: channel,
      });
      await ApiResponseHandler.success(req, res, { ok: true });
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};
