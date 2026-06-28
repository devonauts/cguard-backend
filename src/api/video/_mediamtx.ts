/**
 * MediaMTX integration — the enterprise delivery path.
 *
 * MediaMTX ingests the camera RTSP on demand and republishes it as deep-buffer
 * MPEG-TS HLS (configured 10×1s segments). The browser plays it with hls.js tuned to
 * buffer ahead — the same "buffer-ahead" model YouTube/Twitch live use, which is what
 * actually kills the rebuffer spinner on a jittery/remote link.
 *
 * Codec strategy (the CPU win):
 *  - H264 source → `-c:v copy`: just REMUX into MPEG-TS (~2% CPU, full native quality).
 *    MPEG-TS demuxing in hls.js accepts the DVR's raw bitstream that the fMP4 MSE
 *    demuxer rejected ("Unrecognized video codec profile"), so no transcode needed.
 *  - H265 / unknown → transcode to H264 720p (only the cameras that truly need it).
 */
const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997';

/** Public HLS base, e.g. https://app.cguardpro.com/mediamtx (derived from GO2RTC_PUBLIC if unset). */
export function mediamtxPublic(): string {
  if (process.env.MEDIAMTX_PUBLIC) return process.env.MEDIAMTX_PUBLIC.replace(/\/+$/, '');
  const g = (process.env.GO2RTC_PUBLIC || '').replace(/\/+$/, '');
  return g ? g.replace(/\/go2rtc$/, '/mediamtx') : '';
}

function runOnDemand(rtsp: string): string {
  const out = 'rtsp://localhost:18554/$MTX_PATH';
  // These XVRs emit a keyframe only every ~12s (they ignore GovLength), so a raw copy
  // yields 12-second HLS segments → ~12s black before the first frame + high latency.
  // We re-encode forcing a keyframe every 2s of wall-clock (works at any fps), which makes
  // HLS segments short → fast start, low latency. ultrafast + capped threads keeps it
  // ~25% CPU/stream (7 cams ≈ 175% of the 4-core box). libx264 also normalises H265
  // sources to H264 for the browser. -an drops the G.711 audio (can't mux to TS/browser).
  return `ffmpeg -rtsp_transport tcp -i ${rtsp} -an -c:v libx264 -preset ultrafast ` +
    `-tune zerolatency -force_key_frames expr:gte(t,n_forced*2) -sc_threshold 0 ` +
    `-threads 2 -crf 23 -f rtsp ${out}`;
}

/**
 * Ensure MediaMTX has an on-demand path for this camera. Idempotent: if the path is
 * already configured we leave it alone (so the live ffmpeg isn't restarted). Returns
 * true when the path exists/was created.
 */
export async function ensureMediamtxPath(name: string, rtsp: string): Promise<boolean> {
  const base = MEDIAMTX_API.replace(/\/+$/, '');
  const f = fetch as any;
  try {
    const g = await f(`${base}/v3/config/paths/get/${encodeURIComponent(name)}`);
    if (g && g.ok) return true; // already configured — don't disturb the running stream
  } catch { /* MediaMTX may be down; fall through and try to add */ }

  const body = JSON.stringify({
    runOnDemand: runOnDemand(rtsp),
    runOnDemandRestart: true,
    runOnDemandCloseAfter: '30s',
  });
  try {
    const r = await f(`${base}/v3/config/paths/add/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    if (r && r.ok) return true;
    // already exists (race) → replace
    const r2 = await f(`${base}/v3/config/paths/replace/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    return !!(r2 && r2.ok);
  } catch (e: any) {
    console.warn('[video] mediamtx register failed:', e?.message || e);
    return false;
  }
}
