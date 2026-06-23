/**
 * Minimal RTP (RFC 3550) session for G.711 PCMU over UDP, used by the SIP bridge.
 * Sends/receives 20 ms frames (160 µ-law bytes @ 8 kHz). No SRTP, no jitter buffer
 * beyond naive ordering — adequate for a LAN RoIP gateway; a media server is the
 * upgrade path for WAN/NAT. Pure dgram so it runs only in the single fork process.
 */
import dgram from 'dgram';

const PT_PCMU = 0; // RTP payload type for G.711 µ-law
const SAMPLES_PER_FRAME = 160; // 20 ms @ 8 kHz

export type RtpOnPayload = (muLaw: Buffer) => void;

export class RtpSession {
  private socket: dgram.Socket | null = null;
  private remoteHost = '';
  private remotePort = 0;
  private seq = (Math.floor(Date.now()) & 0xffff) >>> 0; // seeded; varies per call
  private timestamp = 0;
  private readonly ssrc = ((Date.now() & 0x7fffffff) ^ (process.pid << 8)) >>> 0;
  private onPayload: RtpOnPayload | null = null;
  readonly localPort: number;

  constructor(localPort: number) {
    this.localPort = localPort;
  }

  async bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.on('error', (e) => { try { s.close(); } catch { /* ignore */ } reject(e); });
      s.on('message', (msg) => this.handleIncoming(msg));
      s.bind(this.localPort, () => { this.socket = s; resolve(); });
    });
  }

  setRemote(host: string, port: number): void {
    this.remoteHost = host;
    this.remotePort = port;
  }

  onAudio(cb: RtpOnPayload): void {
    this.onPayload = cb;
  }

  /** Send one 160-byte µ-law frame as an RTP packet. */
  sendFrame(muLaw: Buffer): void {
    if (!this.socket || !this.remoteHost || !this.remotePort) return;
    const header = Buffer.alloc(12);
    header[0] = 0x80; // version 2, no padding/extension/CSRC
    header[1] = PT_PCMU; // marker 0 + PT 0
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + SAMPLES_PER_FRAME) >>> 0;
    const pkt = Buffer.concat([header, muLaw]);
    this.socket.send(pkt, this.remotePort, this.remoteHost, () => { /* fire-and-forget */ });
  }

  /** Split an arbitrary µ-law buffer into 160-byte frames and send each. */
  sendMuLaw(muLaw: Buffer): void {
    for (let off = 0; off < muLaw.length; off += SAMPLES_PER_FRAME) {
      const chunk = muLaw.subarray(off, Math.min(off + SAMPLES_PER_FRAME, muLaw.length));
      this.sendFrame(chunk);
    }
  }

  private handleIncoming(msg: Buffer): void {
    if (!this.onPayload || msg.length <= 12) return;
    // Strip the 12-byte fixed RTP header (+ any CSRC list).
    const cc = msg[0] & 0x0f;
    const headerLen = 12 + cc * 4;
    if (msg.length <= headerLen) return;
    this.onPayload(msg.subarray(headerLen));
  }

  close(): void {
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
  }
}
