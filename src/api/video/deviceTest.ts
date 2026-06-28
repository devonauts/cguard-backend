import net from 'net';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { buildRtspUrl, streamName } from './_videoUrl';

const GO2RTC_API = process.env.GO2RTC_API || '';

// Try a TCP connection to host:port, resolving online/offline within `timeoutMs`.
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) { /* noop */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try { socket.connect(port, host); } catch (e) { done(false); }
  });
}

/**
 * Validate the actual RTSP stream through the go2rtc gateway — a TCP port check
 * only proves the port is open, NOT that the credentials/RTSP path work (so a DVR
 * with the wrong password still reported "online" while every stream failed).
 * Returns a precise status: online | auth_failed | unreachable, or null if no gateway.
 */
async function rtspProbe(rtsp: string): Promise<{ status: string; message?: string } | null> {
  if (!GO2RTC_API || !rtsp || typeof (globalThis as any).fetch !== 'function') return null;
  const api = GO2RTC_API.replace(/\/+$/, '');
  const name = `probe_${streamName(rtsp)}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 60);
  const since = Date.now();
  const f: any = (globalThis as any).fetch;
  try {
    await f(`${api}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(rtsp)}`, { method: 'PUT' }).catch(() => {});

    // Trigger a real connection by pulling one frame (bounded).
    let frameBytes = 0;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await f(`${api}/api/frame.jpeg?src=${encodeURIComponent(name)}`, { signal: ctrl.signal });
      const buf = await r.arrayBuffer();
      frameBytes = buf.byteLength;
    } catch { /* timeout / empty */ } finally { clearTimeout(timer); }

    if (frameBytes > 800) return { status: 'online' };

    // No frame → classify from go2rtc's recent error log for THIS attempt.
    try {
      const logTxt = await (await f(`${api}/api/log`)).text();
      const recent = String(logTxt).split('\n')
        .filter((l) => l.includes('"level":"error"'))
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((o: any) => o && typeof o.time === 'number' && o.time >= since)
        .map((o: any) => String(o.error || ''))
        .join(' | ');
      if (/wrong user\/pass/i.test(recent)) return { status: 'auth_failed', message: 'Credenciales incorrectas: el DVR rechazó el usuario/contraseña.' };
      if (/404|not found/i.test(recent)) return { status: 'unreachable', message: 'Conecta pero la ruta RTSP no existe (revisa marca/canal).' };
      if (/refused|timeout|no route|unreachable/i.test(recent)) return { status: 'unreachable', message: 'No se pudo conectar al stream RTSP.' };
      if (recent) return { status: 'unreachable', message: recent.slice(0, 140) };
    } catch { /* ignore */ }
    return { status: 'unreachable', message: 'Sin video (timeout al leer el stream).' };
  } finally {
    try { await f(`${api}/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {}); } catch { /* ignore */ }
  }
}

// POST /tenant/:tenantId/video/device/:id/test
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const record = await db.videoDevice.findOne({ where: { id: req.params.id, tenantId } });
    if (!record) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    const host = record.host;
    const port = Number(record.port) || 554;

    let status = 'offline';
    let message: string | undefined;

    if (host && (await tcpProbe(String(host), port, 3000))) {
      // Port reachable — now validate the actual stream (credentials + path).
      const rtsp = record.connectionMode === 'relay'
        ? null // relay devices publish into the cloud ingest; skip direct LAN probe
        : buildRtspUrl(record, 1);
      const probe = rtsp ? await rtspProbe(rtsp) : null;
      if (probe) { status = probe.status; message = probe.message; }
      else { status = 'online'; } // gateway off / relay → fall back to reachability
    } else {
      message = 'El equipo no responde en la red (host/puerto inalcanzable).';
    }

    const update: any = { status };
    if (status === 'online') update.lastSeenAt = new Date();
    await record.update(update);

    await ApiResponseHandler.success(req, res, { status, message });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
