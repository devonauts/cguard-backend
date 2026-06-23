/**
 * RoIP/SIP bridge orchestration. For each ACTIVE radioDevice it brings up a SIP UA
 * + RTP session to the gateway and relays audio both ways into the tenant's app PTT
 * channel (lib/radioVoice):
 *   radio → app : inbound RTP (PCMU 8k) → PCM → radioVoice.bridgeSendPcm(tenant, …, 8000)
 *   app → radio : Redis RELAY_CHANNEL chunks (µ-law 16k from guards) → 8k µ-law → RTP
 *
 * Runs ONLY in the single fork process (src/sipBridge.ts) — it owns UDP sockets and
 * must not be cluster-replicated. Floor handoff is handled by radioVoice's bridge*
 * helpers (the radio yields to a guard already holding the floor).
 */
import { createClient } from 'redis';
import { decrypt } from '../../lib/secretBox';
import {
  initRelay,
  bridgeBegin,
  bridgeSendPcm,
  bridgeEnd,
  RELAY_CHANNEL,
} from '../../lib/radioVoice';
import { SipUa } from './sipUa';
import { RtpSession } from './rtpSession';
import {
  rtpMuLawToPcm16,
  appMuLawToRtpMuLaw,
} from './audioTranscode';
import { CONTROL_CHANNEL } from './sipBridgeControl';

const INBOUND_GAP_MS = 400; // radio "un-key" after this much silence
let sipPortCursor = 5070;

interface Session {
  deviceId: string;
  tenantId: string;
  name: string;
  sip: SipUa;
  rtp: RtpSession;
  inboundTimer: NodeJS.Timeout | null;
  keyed: boolean;
}

export class SipBridge {
  private db: any;
  private sessions = new Map<string, Session>(); // deviceId → session
  private sub: any = null;

  constructor(db: any) {
    this.db = db;
  }

  async start(): Promise<void> {
    await initRelay(null as any); // connect Redis pub/sub for cross-process fanout (no io in this process)
    if (process.env.REDIS_URL) {
      this.sub = createClient({ url: process.env.REDIS_URL });
      this.sub.on('error', () => { /* ignore */ });
      await this.sub.connect();
      // app → radio audio
      await this.sub.subscribe(RELAY_CHANNEL, (msg: string) => this.onRelay(msg));
      // control messages from the API cluster (register/reload)
      await this.sub.subscribe(CONTROL_CHANNEL, (msg: string) => this.onControl(msg));
    }
    await this.reloadAll();
  }

  /** (Re)load all active devices and start any that aren't running. */
  async reloadAll(): Promise<void> {
    let rows: any[] = [];
    try {
      rows = await this.db.radioDevice.findAll({ where: { active: true } });
    } catch (e: any) {
      console.warn('[sipBridge] could not load radioDevices:', e?.message || e);
      return;
    }
    const wanted = new Set<string>();
    for (const row of rows) {
      const d = typeof row.get === 'function' ? row.get({ plain: true }) : row;
      wanted.add(d.id);
      if (!this.sessions.has(d.id)) await this.startDevice(d).catch((e) => this.markError(d, e));
    }
    // Stop sessions whose device is no longer active.
    for (const id of [...this.sessions.keys()]) {
      if (!wanted.has(id)) this.stopDevice(id);
    }
  }

  private async startDevice(d: any): Promise<void> {
    const rtpPort = Number(d.rtpPortStart) || 16000;
    const localSip = sipPortCursor++;
    const rtp = new RtpSession(rtpPort);
    await rtp.bind();

    const sip = new SipUa({
      host: d.host,
      sipPort: Number(d.sipPort) || 5060,
      username: d.sipUsername || '',
      password: decrypt(d.sipPassword) || '',
      domain: d.sipDomain || d.host,
      extension: d.extension || undefined,
      localPort: localSip,
      localRtpPort: rtpPort,
    });

    const session: Session = {
      deviceId: d.id, tenantId: d.tenantId, name: d.name,
      sip, rtp, inboundTimer: null, keyed: false,
    };

    sip.on('registered', () => this.setStatus(d.id, 'registered', null));
    sip.on('media', (host: string, port: number) => rtp.setRemote(host, port));
    sip.on('error', (e: any) => this.setStatus(d.id, 'error', e?.message || String(e)));
    sip.on('bye', () => { /* call ended; SIP re-INVITE on next register cycle */ });

    // radio → app
    rtp.onAudio((muLaw: Buffer) => this.onInboundRtp(session, muLaw));

    this.sessions.set(d.id, session);
    await sip.start();
  }

  private onInboundRtp(s: Session, muLaw: Buffer): void {
    // Key up on first frame of a transmission; pace = real-time RTP arrival.
    if (!s.keyed) {
      s.keyed = true;
      bridgeBegin(s.tenantId, s.name).catch(() => {});
    }
    bridgeSendPcm(s.tenantId, rtpMuLawToPcm16(muLaw), 8000);
    if (s.inboundTimer) clearTimeout(s.inboundTimer);
    s.inboundTimer = setTimeout(() => {
      s.keyed = false;
      bridgeEnd(s.tenantId).catch(() => {});
    }, INBOUND_GAP_MS);
  }

  // app → radio: forward guard audio (µ-law 16k) to every session of that tenant.
  private onRelay(msg: string): void {
    let e: any;
    try { e = JSON.parse(msg); } catch { return; }
    if (e.k !== 'chunk' || !e.t || typeof e.d !== 'string') return;
    if (typeof e.s === 'string' && (e.s.startsWith('roip:') || e.s.startsWith('ai:'))) return; // don't echo radio/AI back
    const appMuLaw = Buffer.from(e.d, 'base64');
    const rtpMuLaw = appMuLawToRtpMuLaw(appMuLaw);
    for (const s of this.sessions.values()) {
      if (s.tenantId === e.t) s.rtp.sendMuLaw(rtpMuLaw);
    }
  }

  private onControl(msg: string): void {
    let e: any;
    try { e = JSON.parse(msg); } catch { return; }
    if (e.type === 'register' || e.type === 'reload') this.reloadAll().catch(() => {});
  }

  private stopDevice(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.inboundTimer) clearTimeout(s.inboundTimer);
    try { s.sip.stop(); } catch { /* ignore */ }
    try { s.rtp.close(); } catch { /* ignore */ }
    this.sessions.delete(id);
  }

  private async setStatus(id: string, status: string, lastError: string | null): Promise<void> {
    try {
      await this.db.radioDevice.update(
        { status, lastError, lastSeenAt: status === 'registered' ? new Date() : undefined },
        { where: { id } },
      );
    } catch { /* ignore */ }
  }

  private markError(d: any, e: any): void {
    this.setStatus(d.id, 'error', e?.message || String(e)).catch(() => {});
  }

  async stop(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.stopDevice(id);
    try { await this.sub?.unsubscribe(); } catch { /* ignore */ }
    try { await this.sub?.quit(); } catch { /* ignore */ }
  }
}
