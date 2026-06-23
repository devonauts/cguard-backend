/**
 * Minimal SIP user-agent over UDP for the RoIP bridge: REGISTER (with MD5 digest
 * auth), outbound INVITE → ACK with an SDP offering PCMU, and BYE. Enough to bring
 * up a G.711 media path to a RoIP/SIP gateway on the LAN. Not a full RFC 3261 stack
 * (no TCP/TLS, no full transaction layer) — the upgrade path for WAN/NAT is a media
 * server (Asterisk/FreeSWITCH). Runs only inside the single cguard-sip-bridge fork.
 *
 * NOTE: this path can only be validated against a real gateway. It is intentionally
 * not auto-started in prod until creds + UDP networking are in place.
 */
import dgram from 'dgram';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const rand = (n = 8) => crypto.randomBytes(n).toString('hex');

export interface SipConfig {
  host: string;          // gateway IP/host
  sipPort: number;       // gateway SIP port (5060)
  username: string;
  password: string;
  domain: string;        // realm/domain (defaults to host)
  extension?: string;    // extension/talkgroup to INVITE; if absent, REGISTER only
  localPort: number;     // our SIP UDP port
  localRtpPort: number;  // our RTP port to advertise in SDP
  expires?: number;      // REGISTER expiry seconds
}

export class SipUa extends EventEmitter {
  private sock: dgram.Socket | null = null;
  private cfg: SipConfig;
  private callId = `${rand(12)}@cguard`;
  private fromTag = rand(6);
  private cseq = 1;
  private localIp = '0.0.0.0';
  private nc = 0;
  private closed = false;

  constructor(cfg: SipConfig) {
    super();
    this.cfg = { expires: 300, ...cfg, domain: cfg.domain || cfg.host };
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.on('error', (e) => { this.emit('error', e); });
      s.on('message', (m) => this.onMessage(m.toString('utf8')));
      s.bind(this.cfg.localPort, () => {
        this.sock = s;
        try { this.localIp = (s.address() as any).address || '0.0.0.0'; } catch { /* ignore */ }
        resolve();
      });
      s.once('error', reject);
    });
    this.register();
  }

  // ── SIP message assembly ──────────────────────────────────────────────────
  private send(msg: string) {
    if (!this.sock) return;
    this.sock.send(Buffer.from(msg, 'utf8'), this.cfg.sipPort, this.cfg.host);
  }

  private authHeader(method: string, uri: string, ch: Record<string, string>): string {
    const { username, password, domain } = this.cfg;
    const realm = ch.realm || domain;
    const nonce = ch.nonce || '';
    const qop = ch.qop;
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    let response: string;
    let extra = '';
    if (qop) {
      const cnonce = rand(8);
      const ncHex = (++this.nc).toString(16).padStart(8, '0');
      response = md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`);
      extra = `, qop=auth, nc=${ncHex}, cnonce="${cnonce}"`;
    } else {
      response = md5(`${ha1}:${nonce}:${ha2}`);
    }
    const algo = ch.algorithm ? `, algorithm=${ch.algorithm}` : '';
    const opaque = ch.opaque ? `, opaque="${ch.opaque}"` : '';
    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"${algo}${opaque}${extra}`;
  }

  private parseChallenge(line: string): Record<string, string> {
    const out: Record<string, string> = {};
    const body = line.replace(/^[^ ]+ Digest /i, '').trim();
    body.split(',').forEach((kv) => {
      const m = kv.trim().match(/^([a-zA-Z]+)=("?)([^"]*)\2$/);
      if (m) out[m[1].toLowerCase()] = m[3];
    });
    return out;
  }

  private sdp(): string {
    const ip = this.localIp;
    return [
      'v=0',
      `o=cguard ${Date.now()} ${Date.now()} IN IP4 ${ip}`,
      's=cguard-roip',
      `c=IN IP4 ${ip}`,
      't=0 0',
      `m=audio ${this.cfg.localRtpPort} RTP/AVP 0 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=ptime:20',
      'a=sendrecv',
    ].join('\r\n') + '\r\n';
  }

  private register(auth?: string) {
    const uri = `sip:${this.cfg.domain}`;
    const branch = `z9hG4bK${rand(6)}`;
    const cseq = this.cseq++;
    const lines = [
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.cfg.localPort};branch=${branch};rport`,
      `Max-Forwards: 70`,
      `From: <sip:${this.cfg.username}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: <sip:${this.cfg.username}@${this.cfg.domain}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} REGISTER`,
      `Contact: <sip:${this.cfg.username}@${this.localIp}:${this.cfg.localPort}>`,
      `Expires: ${this.cfg.expires}`,
      ...(auth ? [`Authorization: ${auth}`] : []),
      `Content-Length: 0`,
      '', '',
    ];
    this.send(lines.join('\r\n'));
  }

  private invite(auth?: string) {
    if (!this.cfg.extension) return;
    const uri = `sip:${this.cfg.extension}@${this.cfg.domain}`;
    const branch = `z9hG4bK${rand(6)}`;
    const cseq = this.cseq++;
    const body = this.sdp();
    const lines = [
      `INVITE ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.cfg.localPort};branch=${branch};rport`,
      `Max-Forwards: 70`,
      `From: <sip:${this.cfg.username}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: <${uri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:${this.cfg.username}@${this.localIp}:${this.cfg.localPort}>`,
      `Content-Type: application/sdp`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ];
    this.send(lines.join('\r\n'));
  }

  // ── Response handling ─────────────────────────────────────────────────────
  private onMessage(msg: string) {
    if (this.closed) return;
    const firstLine = msg.split('\r\n')[0] || '';
    const status = parseInt(firstLine.split(' ')[1] || '0', 10);
    const isRegister = /CSeq:.*REGISTER/i.test(msg);
    const isInvite = /CSeq:.*INVITE/i.test(msg);

    if (status === 401 || status === 407) {
      const chLine = (msg.split('\r\n').find((l) => /^(WWW-Authenticate|Proxy-Authenticate):/i.test(l))) || '';
      const ch = this.parseChallenge(chLine);
      if (isRegister) this.register(this.authHeader('REGISTER', `sip:${this.cfg.domain}`, ch));
      else if (isInvite) this.invite(this.authHeader('INVITE', `sip:${this.cfg.extension}@${this.cfg.domain}`, ch));
      return;
    }

    if (status === 200 && isRegister) {
      this.emit('registered');
      // schedule re-register at ~80% of the expiry window
      setTimeout(() => { if (!this.closed) this.register(); }, (this.cfg.expires! * 1000) * 0.8);
      if (this.cfg.extension) this.invite();
      return;
    }

    if (status === 200 && isInvite) {
      const media = this.parseSdpMedia(msg);
      if (media) this.emit('media', media.host, media.port);
      this.sendAck();
      return;
    }

    if (firstLine.startsWith('BYE')) {
      this.send(this.buildResponse(msg, '200 OK'));
      this.emit('bye');
    }
  }

  private parseSdpMedia(msg: string): { host: string; port: number } | null {
    const body = msg.split('\r\n\r\n')[1] || '';
    const cLine = body.split('\r\n').find((l) => l.startsWith('c=IN IP4'));
    const mLine = body.split('\r\n').find((l) => l.startsWith('m=audio'));
    if (!cLine || !mLine) return null;
    const host = cLine.trim().split(' ')[2];
    const port = parseInt(mLine.trim().split(' ')[1], 10);
    return host && port ? { host, port } : null;
  }

  private sendAck() {
    if (!this.cfg.extension) return;
    const uri = `sip:${this.cfg.extension}@${this.cfg.domain}`;
    const lines = [
      `ACK ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.cfg.localPort};branch=z9hG4bK${rand(6)};rport`,
      `Max-Forwards: 70`,
      `From: <sip:${this.cfg.username}@${this.cfg.domain}>;tag=${this.fromTag}`,
      `To: <${uri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq - 1} ACK`,
      `Content-Length: 0`,
      '', '',
    ];
    this.send(lines.join('\r\n'));
  }

  private buildResponse(reqMsg: string, statusLine: string): string {
    const headers = reqMsg.split('\r\n');
    const pick = (name: string) => headers.find((h) => h.toLowerCase().startsWith(name.toLowerCase())) || '';
    return [
      `SIP/2.0 ${statusLine}`,
      pick('Via:'), pick('From:'), pick('To:'), pick('Call-ID:'), pick('CSeq:'),
      'Content-Length: 0', '', '',
    ].join('\r\n');
  }

  stop() {
    this.closed = true;
    // Best-effort REGISTER with Expires:0 to deregister could go here.
    try { this.sock?.close(); } catch { /* ignore */ }
    this.sock = null;
  }
}
