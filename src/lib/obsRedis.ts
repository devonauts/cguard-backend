/**
 * Shared Redis client for observability cross-worker aggregation (job stats,
 * slow-query rollups). Singleton, best-effort: returns null without REDIS_URL or
 * on any connection failure, so callers degrade to the local worker's data.
 */
import { createClient } from 'redis';

let client: any = null;
let connecting = false;

export async function getObsRedis(): Promise<any> {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (client) return client;
  if (connecting) return null;
  connecting = true;
  try {
    const c = createClient({ url });
    c.on('error', () => {});
    await c.connect();
    client = c;
    return client;
  } catch {
    client = null;
    return null;
  } finally {
    connecting = false;
  }
}

export const OBS_INSTANCE = String(process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? process.pid);
