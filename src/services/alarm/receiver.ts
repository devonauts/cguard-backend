/**
 * Alarm receiver — Phase 1 central-station listener.
 *
 * Accepts inbound alarm traffic over TCP and UDP from:
 *   - panels reporting DIRECTLY over IP/cellular (SIA DC-09 frames, often
 *     carrying an ADM-CID Contact ID payload), and
 *   - HARDWARE receivers (Sur-Gard / DSC) forwarding their automation output.
 *
 * Flow per datagram / TCP chunk:
 *   1) detectFormat() classifies the wire bytes;
 *   2) the matching protocol parser decodes it;
 *   3) we map it to an ingestSignal() payload;
 *   4) we resolve the owning TENANT by the central-station account number
 *      (cross-tenant lookup) so multi-tenant routing works with no per-port
 *      tenant config;
 *   5) we PERSIST the signal (ingestSignal) BEFORE sending an ACK — the panel
 *      must never get an ACK for a signal we failed to store;
 *   6) for DC-09 we send the proper DC-09 ACK (or NAK on CRC failure).
 *
 * Ports come from env: ALARM_TCP_PORT / ALARM_UDP_PORT (default 6543). Binds
 * 0.0.0.0. `resolveDb` returns the initialized Sequelize models bundle.
 */

import * as net from 'net';
import * as dgram from 'dgram';
import { detectFormat } from './protocols/detect';
import { parseDc09, buildAck, buildNak, Dc09Parsed } from './protocols/siaDc09';
import { parseContactId, contactIdQualifierLabel } from './protocols/contactId';
import { parseSurgard } from './protocols/surgard';
import { ingestSignal, resolvePanelByAccount, IngestSignalInput } from './normalizer';

export interface StartReceiverOptions {
  tcpPort?: number;
  udpPort?: number;
  /** Returns the initialized Sequelize models bundle (db). */
  resolveDb: () => Promise<any> | any;
  /** Optional bind host. Defaults to 0.0.0.0. */
  host?: string;
  /** Optional logger. Defaults to console. */
  logger?: { log: (...a: any[]) => void; error: (...a: any[]) => void };
}

export interface ReceiverHandles {
  tcpServer: net.Server;
  udpSocket: dgram.Socket;
  close: () => Promise<void>;
}

/** Result of decoding a raw buffer into something ingestSignal can take. */
interface Decoded {
  payload: IngestSignalInput;
  /** the parsed DC-09 frame, when present, so we can build the ACK */
  dc09?: Dc09Parsed;
  /** true when DC-09 CRC failed -> respond NAK, do not ingest a bad frame */
  dc09CrcFail?: boolean;
  /** DC-09 link-test (NULL token) — ACK but do not create a case */
  linkTest?: boolean;
}

/**
 * Decode a raw inbound buffer into an ingestSignal payload (+ DC-09 context).
 * Pure-ish: only calls the protocol parsers, no DB.
 */
export function decodeBuffer(buf: Buffer, channelHint: string): Decoded | null {
  const fmt = detectFormat(buf);

  if (fmt === 'dc09') {
    const parsed = parseDc09(buf);

    // Link test (NULL token) — keep-alive supervision; ACK but no event.
    if ((parsed.token || '').toUpperCase() === 'NULL') {
      return {
        linkTest: true,
        dc09: parsed,
        payload: {
          accountNumber: parsed.account,
          format: 'sia',
          eventCode: 'NULL',
          qualifier: 'status',
          raw: parsed.raw,
          channel: channelHint,
          receiverId: parsed.receiver || null,
        },
      };
    }

    if (!parsed.crcOk) {
      return { dc09: parsed, dc09CrcFail: true, payload: { raw: parsed.raw } };
    }

    const token = (parsed.token || '').toUpperCase();

    // ADM-CID: the DC-09 [data] block carries Contact ID digits.
    if (token === 'ADM-CID' || /^\d{16,}$/.test((parsed.data || '').replace(/[^0-9A-Fa-f]/g, ''))) {
      const cid = parseContactId(parsed.data);
      return {
        dc09: parsed,
        payload: {
          accountNumber: parsed.account || cid.account,
          zoneNumber: cid.zone || null,
          partition: cid.partition || null,
          format: 'contactid',
          eventCode: cid.eventCode,
          qualifier: contactIdQualifierLabel(cid.qualifier),
          raw: parsed.raw,
          channel: channelHint,
          receiverId: parsed.receiver || null,
        },
      };
    }

    // SIA-DCS: native SIA. The [data] block holds a SIA block like
    //   Nri1/BA01  (Nri<part> / <2-letter code><zone>) — best-effort extract.
    const sia = extractSiaBlock(parsed.data);
    return {
      dc09: parsed,
      payload: {
        accountNumber: parsed.account,
        zoneNumber: sia.zone || null,
        partition: sia.partition || null,
        format: 'sia',
        eventCode: sia.code || null,
        qualifier: sia.qualifier,
        raw: parsed.raw,
        channel: channelHint,
        receiverId: parsed.receiver || null,
      },
    };
  }

  if (fmt === 'contactid') {
    const text = buf.toString('binary').replace(/[\x02\x03\r\n]/g, '').trim();
    const cid = parseContactId(text);
    return {
      payload: {
        accountNumber: cid.account,
        zoneNumber: cid.zone || null,
        partition: cid.partition || null,
        format: 'contactid',
        eventCode: cid.eventCode,
        qualifier: contactIdQualifierLabel(cid.qualifier),
        raw: text,
        channel: channelHint,
      },
    };
  }

  if (fmt === 'surgard') {
    const line = buf.toString('binary');
    const sg = parseSurgard(line);
    return {
      payload: {
        accountNumber: sg.account,
        zoneNumber: sg.zone || null,
        partition: sg.partition || null,
        format: 'surgard',
        eventCode: sg.eventCode || null,
        qualifier: sg.qualifier,
        raw: sg.raw,
        channel: 'receiver',
        receiverId: sg.receiver || null,
      },
    };
  }

  return null;
}

/**
 * Best-effort extraction of a SIA-DCS data block (e.g. "Nri1/BA01" or "|BA01").
 * Returns { code, zone, partition, qualifier }.
 *
 * NOTE: full SIA DC-03 block parsing is richer (modifiers, multiple blocks);
 * this covers the common single-event form. The protocols agent owns the
 * canonical decode; here we only need enough to map a code.
 */
function extractSiaBlock(data: string): {
  code: string | null;
  zone: string | null;
  partition: string | null;
  qualifier: string;
} {
  const out = { code: null as string | null, zone: null as string | null, partition: null as string | null, qualifier: 'event' };
  if (!data) return out;

  // A SIA block is "[N]<modifiers>/<EVENT>" where modifiers may include a
  // partition "ri<part>" and an account "N..". The real event token follows
  // the last '/'. Examples: "Nri1/BA01", "ri01/FA005", "BA01".
  const part = data.match(/ri(\d+)/i);
  if (part) out.partition = part[1];

  // Take the segment after the last '/', else the whole block (sans leading N).
  const slash = data.lastIndexOf('/');
  let seg = slash >= 0 ? data.slice(slash + 1) : data.replace(/^N/, '');

  // The event token: 2 letters + optional zone digits, e.g. BA01, FA, TA12.
  const ev = seg.match(/([A-Za-z]{2})(\d{1,4})?/);
  if (ev) {
    out.code = ev[1].toUpperCase();
    if (ev[2]) out.zone = ev[2];
    // R-prefix / explicit restore letter pairs are handled by the codes map.
  }
  return out;
}

/**
 * Handle one inbound message: decode -> resolve tenant by account ->
 * persist (ingestSignal) -> return an optional reply Buffer (DC-09 ACK/NAK).
 */
async function handleMessage(
  db: any,
  buf: Buffer,
  channelHint: string,
  log: { log: (...a: any[]) => void; error: (...a: any[]) => void },
): Promise<Buffer | null> {
  let decoded: Decoded | null = null;
  try {
    decoded = decodeBuffer(buf, channelHint);
  } catch (e: any) {
    log.error('[receiver] decode error:', e?.message || e);
  }

  if (!decoded) {
    log.error('[receiver] unrecognized frame:', JSON.stringify(buf.toString('binary').slice(0, 120)));
    return null;
  }

  // DC-09 CRC failure: respond NAK, do not ingest a corrupt frame.
  if (decoded.dc09CrcFail && decoded.dc09) {
    log.error('[receiver] DC-09 CRC failed; sending NAK');
    return buildNak(decoded.dc09);
  }

  // Resolve the owning tenant by central-station account number.
  const account = decoded.payload.accountNumber || '';
  let tenantId: string | null = null;
  try {
    const panel = await resolvePanelByAccount(db, account);
    if (panel) tenantId = panel.tenantId;
  } catch (e: any) {
    log.error('[receiver] panel/tenant lookup error:', e?.message || e);
  }

  // PERSIST BEFORE ACK. If we know the tenant, run the full pipeline; if not,
  // we still must not ACK a signal we cannot attribute — but for link tests we
  // ACK regardless to keep supervision green.
  if (tenantId) {
    try {
      const result = await ingestSignal(db, tenantId, decoded.payload);
      if (decoded.linkTest) {
        log.log(`[receiver] link test acct=${account} tenant=${tenantId}`);
      } else {
        log.log(
          `[receiver] ingested acct=${account} fmt=${decoded.payload.format} code=${decoded.payload.eventCode} ` +
            `case=${result.case ? result.case.id : '-'} suppressed=${result.suppressed}`,
        );
      }
    } catch (e: any) {
      log.error('[receiver] ingest failed:', e?.message || e);
      // Do NOT ACK on a persistence failure (except link tests) so the panel
      // retransmits.
      if (!decoded.linkTest) return null;
    }
  } else {
    // Unknown account. Record nothing we can attribute; warn loudly.
    log.error(`[receiver] no panel for account "${account}" — not ingested`);
    if (!decoded.linkTest) return null;
  }

  // Build the DC-09 ACK if this was a DC-09 frame.
  if (decoded.dc09) {
    return buildAck(decoded.dc09);
  }
  return null;
}

/**
 * Start the TCP + UDP alarm receiver. Returns handles for clean shutdown.
 */
export function startReceiver(opts: StartReceiverOptions): ReceiverHandles {
  const host = opts.host || '0.0.0.0';
  const tcpPort = opts.tcpPort ?? Number(process.env.ALARM_TCP_PORT) ?? 6543;
  const udpPort = opts.udpPort ?? Number(process.env.ALARM_UDP_PORT) ?? 6543;
  const log = opts.logger || console;

  const getDb = async () => opts.resolveDb();

  // ---- TCP ----
  const tcpServer = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log.log(`[receiver/tcp] connection from ${peer}`);

    socket.on('data', async (chunk: Buffer) => {
      try {
        const db = await getDb();
        const reply = await handleMessage(db, chunk, 'ip', log);
        if (reply && !socket.destroyed) socket.write(reply);
      } catch (e: any) {
        log.error('[receiver/tcp] handler error:', e?.message || e);
      }
    });

    socket.on('error', (e: any) => log.error(`[receiver/tcp] socket error ${peer}:`, e?.message || e));
    socket.on('close', () => log.log(`[receiver/tcp] closed ${peer}`));
    // Many alarm panels expect the connection held open between messages.
    socket.setKeepAlive(true, 30000);
  });

  tcpServer.on('error', (e: any) => log.error('[receiver/tcp] server error:', e?.message || e));
  tcpServer.listen(tcpPort, host, () => {
    log.log(`[receiver/tcp] listening on ${host}:${tcpPort}`);
  });

  // ---- UDP ----
  const udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', async (msg: Buffer, rinfo) => {
    try {
      const db = await getDb();
      const reply = await handleMessage(db, msg, 'cellular', log);
      if (reply) {
        udpSocket.send(reply, rinfo.port, rinfo.address, (e) => {
          if (e) log.error('[receiver/udp] reply send error:', e?.message || e);
        });
      }
    } catch (e: any) {
      log.error('[receiver/udp] handler error:', e?.message || e);
    }
  });
  udpSocket.on('error', (e: any) => log.error('[receiver/udp] socket error:', e?.message || e));
  udpSocket.bind(udpPort, host, () => {
    log.log(`[receiver/udp] listening on ${host}:${udpPort}`);
  });

  const close = () =>
    new Promise<void>((resolve) => {
      let pending = 2;
      const done = () => {
        pending -= 1;
        if (pending === 0) resolve();
      };
      tcpServer.close(done);
      try {
        udpSocket.close(done);
      } catch {
        done();
      }
    });

  return { tcpServer, udpSocket, close };
}

export default { startReceiver, decodeBuffer };
