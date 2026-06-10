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

  socket.on('radio:voice:join', async (_p: any, ack?: (r: any) => void) => {
    if (!isAllowed(socket)) return ack?.({ ok: false, error: 'forbidden' });
    socket.join(room(tenantId));
    const r = await roster(io, tenantId);
    const cur = speakers.get(tenantId) || null;
    socket.to(room(tenantId)).emit('radio:voice:presence', { roster: r });
    ack?.({ ok: true, roster: r, speaker: cur ? { userId: cur.userId, name: cur.name } : null });
  });

  socket.on('radio:voice:leave', async (_p: any, ack?: (r: any) => void) => {
    await leave();
    ack?.({ ok: true });
  });

  socket.on('radio:voice:talk-request', (_p: any, ack?: (r: any) => void) => {
    if (!socket.rooms.has(room(tenantId))) return ack?.({ ok: false, error: 'not_joined' });
    const cur = speakers.get(tenantId);
    if (cur && cur.socketId !== socket.id) {
      return ack?.({ ok: false, error: 'busy', speaker: { userId: cur.userId, name: cur.name } });
    }
    speakers.set(tenantId, { userId, name: name || 'Usuario', socketId: socket.id });
    io.to(room(tenantId)).emit('radio:voice:speaker', { speaking: true, userId, name });
    ack?.({ ok: true });
  });

  // Binary µ-law frame from the current floor holder → relay to listeners only.
  socket.on('radio:voice:chunk', (chunk: ArrayBuffer | Buffer) => {
    const cur = speakers.get(tenantId);
    if (!cur || cur.socketId !== socket.id) return; // only the floor holder may transmit
    socket.to(room(tenantId)).emit('radio:voice:chunk', chunk);
  });

  socket.on('radio:voice:talk-end', () => releaseFloor());

  socket.on('disconnect', () => { void leave(); });
}
