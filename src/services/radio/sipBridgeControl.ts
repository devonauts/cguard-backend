/**
 * Control channel from the API (cluster) → the single cguard-sip-bridge process.
 * The API can't own SIP/RTP sockets (it's a multi-instance cluster), so it asks the
 * bridge to act (e.g. re-register a device, reload config) via a Redis pub/sub
 * message. No-op when REDIS_URL is unset (single-box dev) — the bridge polls the
 * radioDevice table on a timer as a fallback.
 */
import { createClient } from 'redis';

const CONTROL_CHANNEL = 'sip-bridge:control';

let pub: any = null;
let ready = false;

async function client(): Promise<any | null> {
  if (!process.env.REDIS_URL) return null;
  if (pub && ready) return pub;
  if (!pub) {
    try {
      pub = createClient({ url: process.env.REDIS_URL });
      pub.on('error', () => { ready = false; });
      await pub.connect();
      ready = true;
    } catch {
      pub = null;
      ready = false;
      return null;
    }
  }
  return ready ? pub : null;
}

export async function publishControl(event: Record<string, any>): Promise<boolean> {
  const c = await client();
  if (!c) return false;
  try {
    await c.publish(CONTROL_CHANNEL, JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}

/** Ask the bridge to (re)register a specific device now. */
export function requestRegister(tenantId: string, deviceId: string): Promise<boolean> {
  return publishControl({ type: 'register', tenantId, deviceId });
}

export { CONTROL_CHANNEL };
