/**
 * Server-side audio publisher into the LiveKit radio room — the replacement for
 * the old socket.io µ-law relay. Uses @livekit/rtc-node to join the room as a
 * headless bot participant and publish an audio track, so features that speak
 * INTO the channel (the AI radio-check "pase de novedades", and the dormant SIP
 * bridge) reach the LiveKit clients (worker/supervisor/CRM) on the new transport.
 *
 * Room = radio:<tenantId>:<channel> (same as the app token endpoint). Bot tokens
 * are minted server-side with canPublish only. All best-effort: any failure logs
 * and no-ops (never breaks the radio-check flow).
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

// @livekit/rtc-node is a NATIVE module — load it lazily + defensively so a
// missing/incompatible binary on a host only disables server-side broadcast
// (radio-check falls back to a no-op) instead of crashing the whole backend at
// boot (this module is on the radio-check + realtime import path).
let _rtc: typeof import('@livekit/rtc-node') | null | undefined;
function rtcLib(): typeof import('@livekit/rtc-node') | null {
  if (_rtc !== undefined) return _rtc;
  try {
    _rtc = require('@livekit/rtc-node');
  } catch (e: any) {
    console.error('[livekitBroadcast] @livekit/rtc-node unavailable:', e?.message || e);
    _rtc = null;
  }
  return _rtc ?? null;
}

const wsUrl = () => process.env.LIVEKIT_URL || '';
const httpUrl = () => wsUrl().replace(/^ws/, 'http');
const apiKey = () => process.env.LIVEKIT_API_KEY || '';
const apiSecret = () => process.env.LIVEKIT_API_SECRET || '';
const roomFor = (tenantId: string, channel = 'general') => `radio:${tenantId}:${channel}`;

async function botToken(room: string, identity: string, name: string): Promise<string> {
  const at = new AccessToken(apiKey(), apiSecret(), { identity, name, ttl: '5m' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: false });
  return at.toJwt();
}

/** Publish a finite PCM clip (e.g. the radio-check TTS) into the room, then leave. */
export async function broadcastPcmToLiveKit(
  tenantId: string,
  pcm: Int16Array,
  inRate: number,
  speakerName = 'Central de monitoreo',
  channel = 'general',
): Promise<void> {
  const lib = rtcLib();
  if (!lib || !wsUrl() || !apiKey() || !pcm || !pcm.length) return;
  const { Room, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioFrame } = lib;
  const room = roomFor(tenantId, channel);
  const rtc = new Room();
  // Hard ceiling on how long the bot may stay in the room. Without it, a hung
  // captureFrame / waitForPlayout (seen when no client is subscribed to drain the
  // track) keeps the headless publisher connected until its token TTL — the SFU
  // holds it as an active speaker the whole time, so every guard's channel stays
  // stuck on "Central de monitoreo está hablando" and reads as busy. Cap = clip
  // length + 5s slack (min 5s, hard max 2 min) so the bot ALWAYS leaves promptly,
  // freeing the channel the moment its report ends.
  const clipMs = Math.ceil((pcm.length / Math.max(1, inRate)) * 1000);
  const maxMs = Math.min(120000, Math.max(5000, clipMs + 5000));
  let guard: ReturnType<typeof setTimeout> | null = null;
  try {
    const token = await botToken(room, `radiocheck-${tenantId}`, speakerName);
    await rtc.connect(wsUrl(), token, { autoSubscribe: false, dynacast: false });
    const source = new AudioSource(inRate, 1);
    const track = LocalAudioTrack.createAudioTrack('radiocheck', source);
    await rtc.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    const stream = (async () => {
      const per = Math.max(1, Math.floor(inRate / 100)); // 10ms frames
      for (let off = 0; off < pcm.length; off += per) {
        const slice = pcm.subarray(off, Math.min(off + per, pcm.length));
        await source.captureFrame(new AudioFrame(Int16Array.from(slice), inRate, 1, slice.length));
      }
      await source.waitForPlayout();
    })();
    await Promise.race([
      stream,
      new Promise<void>((_, reject) => { guard = setTimeout(() => reject(new Error('broadcast timeout')), maxMs); }),
    ]);
  } catch (e: any) {
    console.error('[livekitBroadcast] failed:', e?.message || e);
  } finally {
    if (guard) { try { clearTimeout(guard); } catch { /* ignore */ } }
    try { await rtc.disconnect(); } catch { /* ignore */ } // bot leaves → channel frees
  }
}

/** Live participant count in the room — replaces the old socket presence count. */
export async function roomParticipantCount(tenantId: string, channel = 'general'): Promise<number> {
  if (!httpUrl() || !apiKey()) return 0;
  try {
    const svc = new RoomServiceClient(httpUrl(), apiKey(), apiSecret());
    const ps = await svc.listParticipants(roomFor(tenantId, channel));
    return (ps || []).length;
  } catch {
    return 0;
  }
}

// ── Streaming publisher for the (dormant) SIP bridge ─────────────────────────
type Bridge = { rtc: any; source: any; rate: number };
const bridges = new Map<string, Bridge>();

export async function bridgeBeginLiveKit(tenantId: string, speakerName = 'Radio', channel = 'general'): Promise<boolean> {
  if (bridges.has(tenantId)) return true;
  const lib = rtcLib();
  if (!lib || !wsUrl() || !apiKey()) return false;
  try {
    const { Room } = lib;
    const rtc = new Room();
    const token = await botToken(roomFor(tenantId, channel), `sipbridge-${tenantId}`, speakerName);
    await rtc.connect(wsUrl(), token, { autoSubscribe: false, dynacast: false });
    bridges.set(tenantId, { rtc, source: null, rate: 0 });
    return true;
  } catch (e: any) {
    console.error('[livekitBridge] begin failed:', e?.message || e);
    return false;
  }
}

export function bridgeSendPcmLiveKit(tenantId: string, pcm: Int16Array, inRate: number): void {
  const b = bridges.get(tenantId);
  const lib = rtcLib();
  if (!lib || !b || !pcm || !pcm.length) return;
  const { AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioFrame } = lib;
  try {
    // Lazily create + publish the track at the first frame's rate.
    if (!b.source) {
      b.rate = inRate;
      b.source = new AudioSource(inRate, 1);
      const track = LocalAudioTrack.createAudioTrack('sipbridge', b.source);
      void b.rtc.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    }
    if (inRate === b.rate) {
      void b.source.captureFrame(new AudioFrame(Int16Array.from(pcm), inRate, 1, pcm.length)).catch(() => {});
    }
  } catch { /* best-effort */ }
}

export async function bridgeEndLiveKit(tenantId: string): Promise<void> {
  const b = bridges.get(tenantId);
  if (!b) return;
  bridges.delete(tenantId);
  try { await b.rtc.disconnect(); } catch { /* ignore */ }
}
