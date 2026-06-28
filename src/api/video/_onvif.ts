/**
 * Minimal ONVIF client for PTZ control (ContinuousMove / Stop). Auth is WS-Security
 * UsernameToken (PasswordDigest). Works against the cheap Hiseeu/Sofia DVRs that route
 * every ONVIF service through /onvif/device_service as well as devices that expose
 * /onvif/ptz_service.
 */
import crypto from 'crypto';
import { decrypt } from '../../lib/secretBox';

const SCHEMA = 'http://www.onvif.org/ver10/schema';
const PTZ = 'http://www.onvif.org/ver20/ptz/wsdl';
const MEDIA = 'http://www.onvif.org/ver10/media/wsdl';

function wsSecurity(user: string, pass: string): string {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)])).digest('base64');
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${user}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
}

function envelope(user: string, pass: string, body: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${wsSecurity(user, pass)}<s:Body>${body}</s:Body></s:Envelope>`;
}

async function post(host: string, user: string, pass: string, body: string): Promise<string> {
  const f: any = (globalThis as any).fetch;
  const xml = envelope(user, pass, body);
  // Try the dedicated PTZ service first, then the catch-all device service.
  for (const path of ['/onvif/ptz_service', '/onvif/device_service', '/onvif/Media']) {
    try {
      const r = await f(`http://${host}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
        body: xml,
        signal: AbortSignal.timeout(6000),
      });
      const text = await r.text();
      if (r.ok && !/notauthorized|not authorized/i.test(text)) return text;
      if (/notauthorized|not authorized/i.test(text)) return text; // auth fault — stop trying
    } catch { /* try next path */ }
  }
  return '';
}

export interface PtzCreds { host: string; username: string; password: string; }

/** Resolve the ONVIF media profile token for a 1-based channel (main stream). */
export async function profileTokenForChannel(c: PtzCreds, channel: number): Promise<string | null> {
  const resp = await post(c.host, c.username, decrypt(c.password) || '', `<GetProfiles xmlns="${MEDIA}"/>`);
  const tokens = Array.from(resp.matchAll(/token="([^"]+)"/g)).map((m) => m[1]);
  const ch = Math.max(1, Number(channel) || 1);
  // Hiseeu/Sofia tokens look like token:16/0/<ch>/1/<ch>/s0 — prefer the main (s0) of this channel.
  return (
    tokens.find((t) => new RegExp(`/0/${ch}/`).test(t) && /s0$/.test(t)) ||
    tokens.find((t) => new RegExp(`/0/${ch}/`).test(t)) ||
    tokens[0] || null
  );
}

const num = (v: any) => Math.max(-1, Math.min(1, Number(v) || 0));

/** Continuous pan/tilt/zoom at the given normalized velocities (-1..1). */
export async function ptzMove(c: PtzCreds, token: string, v: { pan?: number; tilt?: number; zoom?: number }): Promise<boolean> {
  const body = `<ContinuousMove xmlns="${PTZ}"><ProfileToken>${token}</ProfileToken><Velocity><PanTilt x="${num(v.pan)}" y="${num(v.tilt)}" xmlns="${SCHEMA}"/><Zoom x="${num(v.zoom)}" xmlns="${SCHEMA}"/></Velocity></ContinuousMove>`;
  const r = await post(c.host, c.username, decrypt(c.password) || '', body);
  return /ContinuousMoveResponse/i.test(r);
}

export async function ptzStop(c: PtzCreds, token: string): Promise<boolean> {
  const body = `<Stop xmlns="${PTZ}"><ProfileToken>${token}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`;
  const r = await post(c.host, c.username, decrypt(c.password) || '', body);
  return /StopResponse/i.test(r);
}
