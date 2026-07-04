/**
 * Radio "Canal abierto" — live half-duplex PTT relay over the existing socket.io
 * connection (already JWT+tenant authenticated in realtime.ts). One tenant-wide
 * voice channel; audio is relayed frame-by-frame and NEVER stored (live-only).
 *
 * CLUSTER-CORRECT: under PM2 cluster mode peers connect to different workers.
 * Instead of relying on the socket.io Redis adapter's broadcast (which did not
 * reliably fan binary frames across workers), we relay via our OWN Redis pub/sub
 * and emit to LOCAL sockets only — every worker re-emits to its local room
 * members, so the union reaches the whole channel with no duplication. The floor
 * (one talker at a time) is a Redis lock (SET NX PX) so it's correct across
 * workers too. If REDIS_URL is unset we fall back to single-worker (local) mode.
 */
import type { Server as IOServer, Socket } from 'socket.io';
import { createClient } from 'redis';

const VOICE_ROLES = ['admin', 'operationsManager', 'securitySupervisor', 'dispatcher', 'securityGuard', 'owner'];

const room = (tenantId: string) => `rc-voice:${tenantId}`;
const floorKey = (tenantId: string) => `rcfloor:${tenantId}`;
const FLOOR_TTL_MS = 3000; // auto-expires; refreshed by each audio frame
const CH = 'rcv:event'; // cross-worker relay channel

// ---- cross-worker relay (Redis pub/sub + local emit) ----
let ioRef: IOServer | null = null;
let pub: any = null;
let sub: any = null;
let redisReady = false;

// Local record (per worker) of which socket THIS worker granted the floor to.
const localFloor = new Map<string, { userId: string; name: string; socketId: string }>();

export async function initRelay(io: IOServer) {
  ioRef = io;
  if (pub || !process.env.REDIS_URL) return;
  try {
    pub = createClient({ url: process.env.REDIS_URL });
    sub = pub.duplicate();
    pub.on('error', (e: any) => console.warn('[radioVoice] redis pub', e?.message || e));
    sub.on('error', (e: any) => console.warn('[radioVoice] redis sub', e?.message || e));
    await pub.connect();
    await sub.connect();
    await sub.subscribe(CH, (msg: string) => {
      try {
        const e = JSON.parse(msg);
        if (e.k === 'chunk') emitLocal(e.t, 'radio:voice:chunk', Buffer.from(e.d, 'base64'), e.s);
        else emitLocal(e.t, e.ev, e.p);
      } catch { /* ignore */ }
    });
    redisReady = true;
    console.log('[radioVoice] Redis relay ready (cluster fan-out enabled)');
  } catch (e: any) {
    console.warn('[radioVoice] Redis relay init failed — single-worker fallback:', e?.message || e);
  }
}

/** Emit ONLY to this worker's local sockets in the room (optionally excluding one). */
function emitLocal(tenantId: string, event: string, payload: any, exceptId?: string) {
  if (!ioRef) return;
  const r = ioRef.sockets.adapter.rooms.get(room(tenantId));
  if (!r) return;
  for (const sid of r) {
    if (exceptId && sid === exceptId) continue;
    ioRef.sockets.sockets.get(sid)?.emit(event, payload);
  }
}

/** Fan a control event (speaker/presence) to the whole channel across workers. */
function fanoutEvent(tenantId: string, event: string, payload: any) {
  if (redisReady && pub) pub.publish(CH, JSON.stringify({ k: 'ev', t: tenantId, ev: event, p: payload })).catch(() => {});
  else emitLocal(tenantId, event, payload);
}

/** Fan an audio frame to the whole channel across workers (sender excluded). */
function fanoutChunk(tenantId: string, senderSocketId: string, buf: Buffer) {
  if (redisReady && pub) pub.publish(CH, JSON.stringify({ k: 'chunk', t: tenantId, s: senderSocketId, d: buf.toString('base64') })).catch(() => {});
  else emitLocal(tenantId, 'radio:voice:chunk', buf, senderSocketId);
}

function isAllowed(socket: Socket): boolean {
  const d: any = socket.data || {};
  if (d.seeAll) return true;
  const roles: string[] = d.roles || [];
  return roles.some((r) => VOICE_ROLES.includes(r));
}

async function roster(io: IOServer, tenantId: string): Promise<Array<{ userId: string; name: string; role: string }>> {
  const sockets = await io.in(room(tenantId)).fetchSockets();
  const byUser = new Map<string, { userId: string; name: string; role: string }>();
  for (const s of sockets) {
    const d: any = s.data || {};
    if (d.userId && !byUser.has(d.userId)) {
      byUser.set(d.userId, { userId: d.userId, name: d.name || 'Usuario', role: (d.roles || [])[0] || '' });
    }
  }
  return [...byUser.values()];
}

/** Live distinct-user count in a tenant's voice channel (cluster-wide via the
 *  socket.io adapter). Best-effort — 0 if the io ref isn't ready. */
export async function voiceOnlineCount(tenantId: string): Promise<number> {
  if (!ioRef || !tenantId) return 0;
  try {
    const sockets = await ioRef.in(room(tenantId)).fetchSockets();
    const users = new Set<string>();
    for (const s of sockets) { const d: any = s.data || {}; if (d.userId) users.add(d.userId); }
    return users.size;
  } catch { return 0; }
}

/** Current speaker across the cluster (Redis floor), or null. */
async function currentSpeaker(tenantId: string): Promise<{ userId: string; name: string } | null> {
  if (redisReady && pub) {
    try {
      const v = await pub.get(floorKey(tenantId));
      if (!v) return null;
      const [, userId, name] = String(v).split('|');
      return { userId, name };
    } catch { return null; }
  }
  const cur = localFloor.get(tenantId);
  return cur ? { userId: cur.userId, name: cur.name } : null;
}

/** Attach the voice handlers to one connected, authenticated socket. */
export function registerRadioVoice(io: IOServer, socket: Socket): void {
  void initRelay(io);
  const d: any = socket.data || {};
  const { userId, tenantId, name } = d;
  if (!tenantId || !userId) return;

  const dbg = (...a: any[]) => { if (process.env.RADIO_DEBUG === '1') console.log('[radioVoice] pid', process.pid, ...a); };

  const releaseFloor = async () => {
    const cur = localFloor.get(tenantId);
    if (cur && cur.socketId === socket.id) {
      localFloor.delete(tenantId);
      if (redisReady && pub) { try { await pub.del(floorKey(tenantId)); } catch { /* ignore */ } }
      fanoutEvent(tenantId, 'radio:voice:speaker', { speaking: false, userId, name });
      dbg('floor released', userId);
    }
  };

  const leave = async () => {
    await releaseFloor();
    socket.leave(room(tenantId));
    fanoutEvent(tenantId, 'radio:voice:presence', { roster: await roster(io, tenantId) });
  };

  socket.on('radio:voice:join', async (_p: any, ack?: (r: any) => void) => {
    if (!isAllowed(socket)) { dbg('join FORBIDDEN', userId, d.roles); return ack?.({ ok: false, error: 'forbidden' }); }
    socket.join(room(tenantId));
    const r = await roster(io, tenantId);
    const cur = await currentSpeaker(tenantId);
    fanoutEvent(tenantId, 'radio:voice:presence', { roster: r });
    dbg('join ok', userId, 'redis=', redisReady, 'roster=', r.length);
    ack?.({ ok: true, roster: r, speaker: cur });
  });

  socket.on('radio:voice:leave', async (_p: any, ack?: (r: any) => void) => {
    await leave();
    ack?.({ ok: true });
  });

  socket.on('radio:voice:talk-request', async (_p: any, ack?: (r: any) => void) => {
    if (!socket.rooms.has(room(tenantId))) { dbg('talk-request NOT_JOINED', userId); return ack?.({ ok: false, error: 'not_joined' }); }
    const val = `${socket.id}|${userId}|${name || 'Usuario'}`;
    let granted = false;
    if (redisReady && pub) {
      try {
        const res = await pub.set(floorKey(tenantId), val, { NX: true, PX: FLOOR_TTL_MS });
        granted = res === 'OK';
        if (!granted) {
          // We may already hold it (re-press) — allow refresh.
          const existing = await pub.get(floorKey(tenantId));
          if (existing && String(existing).startsWith(`${socket.id}|`)) { granted = true; await pub.pExpire(floorKey(tenantId), FLOOR_TTL_MS); }
        }
      } catch { granted = !localFloor.has(tenantId); }
    } else {
      const cur = localFloor.get(tenantId);
      granted = !cur || cur.socketId === socket.id;
    }
    if (!granted) {
      const sp = await currentSpeaker(tenantId);
      dbg('talk-request BUSY', userId, 'cur=', sp?.userId);
      return ack?.({ ok: false, error: 'busy', speaker: sp || undefined });
    }
    localFloor.set(tenantId, { userId, name: name || 'Usuario', socketId: socket.id });
    fanoutEvent(tenantId, 'radio:voice:speaker', { speaking: true, userId, name });
    dbg('talk-request GRANTED', userId);
    ack?.({ ok: true });
  });

  // Binary µ-law frame from the floor holder → relay to everyone else.
  let chunkCount = 0;
  socket.on('radio:voice:chunk', (chunk: ArrayBuffer | Buffer) => {
    const cur = localFloor.get(tenantId);
    if (!cur || cur.socketId !== socket.id) {
      if ((chunkCount++ % 100) === 0) dbg('chunk DROPPED (not floor holder)', userId);
      return;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    fanoutChunk(tenantId, socket.id, buf);
    if (redisReady && pub) { pub.pExpire(floorKey(tenantId), FLOOR_TTL_MS).catch(() => {}); }
    if ((chunkCount++ % 100) === 0) dbg('chunk relay from', userId, 'bytes=', buf.length, 'redis=', redisReady);
  });

  socket.on('radio:voice:talk-end', () => { void releaseFloor(); });

  socket.on('disconnect', () => { void leave(); });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* AI dispatcher broadcast — inject server-side TTS audio INTO the live channel  */
/* so on-duty guards HEAR it on their already-connected channel (no app rebuild, */
/* and no mobile autoplay problem since the channel's AudioContext is live).     */
/* Audio must match the client wire format exactly: 16 kHz mono µ-law (G.711).   */
/* ────────────────────────────────────────────────────────────────────────── */

const TARGET_RATE = 16000;

/** µ-law (G.711) encode — byte-identical to the client's encodeMuLaw. */
function encodeMuLawBuf(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let pcm = Math.max(-1, Math.min(1, samples[i]));
    pcm = pcm < 0 ? Math.ceil(pcm * 32768) : Math.floor(pcm * 32767);
    let sign = (pcm >> 8) & 0x80;
    if (sign) pcm = -pcm;
    if (pcm > 32635) pcm = 32635;
    pcm += 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { /* find exponent */ }
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Linear resample — same approach as the client. */
function resampleF32(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transmit 16-bit mono PCM (any sample rate, e.g. OpenAI TTS 24 kHz) over the
 * live channel as the AI dispatcher. Holds the floor for the duration so guards
 * don't talk over it, paces frames ~real-time, and clears the floor at the end.
 * Cluster-safe (fanoutChunk relays via Redis to every worker's sockets).
 */
export async function broadcastPcm(
  tenantId: string,
  pcm: Int16Array,
  inRate: number,
  speakerName = 'Central de monitoreo',
): Promise<void> {
  if (!ioRef || !tenantId || !pcm || !pcm.length) return;
  // Peak-normalize the AI audio to near full scale so it isn't quiet on the
  // channel — OpenAI TTS PCM comes well below full level, so it sounded much
  // softer than live mic PTT. Scale so the loudest sample hits ~0.97, with an
  // optional extra boost (RADIO_AI_GAIN, default 1.0), hard-clamped to avoid
  // clipping/distortion.
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > peak) peak = a; }
  const extra = Number(process.env.RADIO_AI_GAIN) || 1;
  const gain = (peak > 0 ? (0.97 * 32767) / peak : 1) * extra;
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let v = (pcm[i] * gain) / 32768;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    f[i] = v;
  }
  const mu = encodeMuLawBuf(resampleF32(f, inRate, TARGET_RATE)); // 16 kHz µ-law bytes
  const FRAME = 1600; // 100 ms @ 16 kHz, 1 byte/sample
  const aiVal = `ai:${tenantId}|ai|${speakerName}`;

  try { if (redisReady && pub) await pub.set(floorKey(tenantId), aiVal, { PX: FLOOR_TTL_MS }); } catch { /* ignore */ }
  fanoutEvent(tenantId, 'radio:voice:speaker', { speaking: true, userId: 'ai-dispatcher', name: speakerName });
  try {
    for (let off = 0; off < mu.length; off += FRAME) {
      fanoutChunk(tenantId, `ai:${tenantId}`, mu.subarray(off, Math.min(off + FRAME, mu.length)) as Buffer);
      try { if (redisReady && pub) await pub.pExpire(floorKey(tenantId), FLOOR_TTL_MS); } catch { /* ignore */ }
      await sleep(100);
    }
  } finally {
    try { if (redisReady && pub) await pub.del(floorKey(tenantId)); } catch { /* ignore */ }
    fanoutEvent(tenantId, 'radio:voice:speaker', { speaking: false, userId: 'ai-dispatcher', name: speakerName });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* RoIP bridge — STREAMING injection (radio → app), used by the SIP bridge      */
/* process. Unlike broadcastPcm (a finite clip), this holds the floor across a   */
/* live transmission and fans out frames as they arrive in real time. Call       */
/* bridgeBegin() when the radio keys up, bridgeSendPcm() per inbound frame, and   */
/* bridgeEnd() on un-key/timeout. Publishes via Redis so it reaches the cluster  */
/* workers' sockets even though the bridge runs in its own process.              */
/* ────────────────────────────────────────────────────────────────────────── */

/** Redis relay channel the bridge process subscribes to for app → radio audio. */
export const RELAY_CHANNEL = CH;

const bridgeHolds = new Map<string, string>(); // tenantId → speakerName while the bridge holds the floor

/** Try to acquire the floor for the radio side. Yields to a guard already talking. */
export async function bridgeBegin(tenantId: string, speakerName: string): Promise<boolean> {
  if (bridgeHolds.has(tenantId)) return true;
  let granted = false;
  if (redisReady && pub) {
    try {
      const res = await pub.set(floorKey(tenantId), `roip:${tenantId}|roip|${speakerName}`, { NX: true, PX: FLOOR_TTL_MS });
      granted = res === 'OK';
      if (!granted) {
        const ex = await pub.get(floorKey(tenantId));
        if (ex && String(ex).startsWith('roip:')) { granted = true; await pub.pExpire(floorKey(tenantId), FLOOR_TTL_MS); }
      }
    } catch { granted = false; }
  } else {
    if (!localFloor.has(tenantId)) { localFloor.set(tenantId, { userId: 'roip', name: speakerName, socketId: `roip:${tenantId}` }); granted = true; }
  }
  if (granted) {
    bridgeHolds.set(tenantId, speakerName);
    fanoutEvent(tenantId, 'radio:voice:speaker', { speaking: true, userId: 'roip-bridge', name: speakerName });
  }
  return granted;
}

/** Fan out one inbound radio frame (PCM16 @ inRate) to the app channel. */
export function bridgeSendPcm(tenantId: string, pcm: Int16Array, inRate: number): void {
  if (!bridgeHolds.has(tenantId) || !pcm.length) return;
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) { let v = pcm[i] / 32768; if (v > 1) v = 1; else if (v < -1) v = -1; f[i] = v; }
  const mu = encodeMuLawBuf(resampleF32(f, inRate, TARGET_RATE)); // → 16 kHz µ-law
  fanoutChunk(tenantId, `roip:${tenantId}`, mu as Buffer);
  if (redisReady && pub) pub.pExpire(floorKey(tenantId), FLOOR_TTL_MS).catch(() => {});
}

/** Release the floor when the radio un-keys (or after an inactivity timeout). */
export async function bridgeEnd(tenantId: string): Promise<void> {
  const name = bridgeHolds.get(tenantId);
  if (!name) return;
  bridgeHolds.delete(tenantId);
  try { if (redisReady && pub) await pub.del(floorKey(tenantId)); else localFloor.delete(tenantId); } catch { /* ignore */ }
  fanoutEvent(tenantId, 'radio:voice:speaker', { speaking: false, userId: 'roip-bridge', name });
}
