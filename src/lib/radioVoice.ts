/**
 * Radio "Canal abierto" — live half-duplex PTT relay over the existing socket.io
 * connection (already JWT+tenant authenticated in realtime.ts). One tenant-wide
 * voice channel; audio is relayed frame-by-frame to the channel room and NEVER
 * stored (live-only). Floor control = one talker at a time.
 *
 * Wire format: the client streams µ-law (G.711) frames as binary; we pass them
 * through untouched. No transcoding, no persistence.
 *
 * Cluster note: floor state below is per-worker in-memory. Cross-worker fan-out
 * of the relayed frames requires the socket.io Redis adapter (REDIS_URL); without
 * it, voice only reaches peers on the same worker. Floor control is strictly
 * correct only within a worker — acceptable for a single channel in testing.
 */
import type { Server as IOServer, Socket } from 'socket.io';

const VOICE_ROLES = ['admin', 'operationsManager', 'securitySupervisor', 'dispatcher', 'securityGuard', 'owner'];

const room = (tenantId: string) => `rc-voice:${tenantId}`;

// tenantId -> current speaker
const speakers = new Map<string, { userId: string; name: string; socketId: string }>();

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

/** Attach the voice handlers to one connected, authenticated socket. */
export function registerRadioVoice(io: IOServer, socket: Socket): void {
  const d: any = socket.data || {};
  const { userId, tenantId, name } = d;
  if (!tenantId || !userId) return;

  const releaseFloor = () => {
    const cur = speakers.get(tenantId);
    if (cur && cur.socketId === socket.id) {
      speakers.delete(tenantId);
      io.to(room(tenantId)).emit('radio:voice:speaker', { speaking: false, userId, name });
    }
  };

  const leave = async () => {
    releaseFloor();
    socket.leave(room(tenantId));
    io.to(room(tenantId)).emit('radio:voice:presence', { roster: await roster(io, tenantId) });
  };

  const dbg = (...a: any[]) => { if (process.env.RADIO_DEBUG === '1') console.log('[radioVoice] pid', process.pid, ...a); };

  socket.on('radio:voice:join', async (_p: any, ack?: (r: any) => void) => {
    if (!isAllowed(socket)) { dbg('join FORBIDDEN', userId, d.roles); return ack?.({ ok: false, error: 'forbidden' }); }
    socket.join(room(tenantId));
    const r = await roster(io, tenantId);
    const cur = speakers.get(tenantId) || null;
    socket.to(room(tenantId)).emit('radio:voice:presence', { roster: r });
    dbg('join ok', userId, 'roster=', r.length, r.map((x) => x.userId));
    ack?.({ ok: true, roster: r, speaker: cur ? { userId: cur.userId, name: cur.name } : null });
  });

  socket.on('radio:voice:leave', async (_p: any, ack?: (r: any) => void) => {
    await leave();
    ack?.({ ok: true });
  });

  socket.on('radio:voice:talk-request', (_p: any, ack?: (r: any) => void) => {
    if (!socket.rooms.has(room(tenantId))) { dbg('talk-request NOT_JOINED', userId); return ack?.({ ok: false, error: 'not_joined' }); }
    const cur = speakers.get(tenantId);
    if (cur && cur.socketId !== socket.id) {
      dbg('talk-request BUSY', userId, 'cur=', cur.userId);
      return ack?.({ ok: false, error: 'busy', speaker: { userId: cur.userId, name: cur.name } });
    }
    speakers.set(tenantId, { userId, name: name || 'Usuario', socketId: socket.id });
    io.to(room(tenantId)).emit('radio:voice:speaker', { speaking: true, userId, name });
    dbg('talk-request GRANTED', userId);
    ack?.({ ok: true });
  });

  // Binary µ-law frame from the current floor holder → relay to listeners only.
  let chunkCount = 0;
  socket.on('radio:voice:chunk', (chunk: ArrayBuffer | Buffer) => {
    const cur = speakers.get(tenantId);
    if (!cur || cur.socketId !== socket.id) {
      if ((chunkCount++ % 50) === 0) dbg('chunk DROPPED (not floor holder)', userId, 'floor=', cur?.userId);
      return; // only the floor holder may transmit
    }
    if ((chunkCount++ % 50) === 0) dbg('chunk relay from', userId, 'bytes=', (chunk as any)?.byteLength ?? (chunk as any)?.length);
    socket.to(room(tenantId)).emit('radio:voice:chunk', chunk);
  });

  socket.on('radio:voice:talk-end', () => releaseFloor());

  socket.on('disconnect', () => { void leave(); });
}
