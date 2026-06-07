import net from 'net';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

// Try a TCP connection to host:port, resolving 'online'/'offline' within `timeoutMs`.
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
    try {
      socket.connect(port, host);
    } catch (e) {
      done(false);
    }
  });
}

// POST /tenant/:tenantId/video/device/:id/test
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoEdit);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const record = await db.videoDevice.findOne({
      where: { id: req.params.id, tenantId },
    });
    if (!record) {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    }

    const host = record.host;
    const port = Number(record.port) || 554;

    let online = false;
    if (host) {
      online = await tcpProbe(String(host), port, 3000);
    }

    const status = online ? 'online' : 'offline';
    const update: any = { status };
    if (online) update.lastSeenAt = new Date();
    await record.update(update);

    await ApiResponseHandler.success(req, res, { status });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
