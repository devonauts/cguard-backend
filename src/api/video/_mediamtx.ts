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
import { execFile } from 'child_process';

const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997';
const FFPROBE = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

// codec is stable per stream; cache so we probe each camera at most once per process.
const codecCache = new Map<string, string>();

/** Public HLS base, e.g. https://app.cguardpro.com/mediamtx (derived from GO2RTC_PUBLIC if unset). */
export function mediamtxPublic(): string {
  if (process.env.MEDIAMTX_PUBLIC) return process.env.MEDIAMTX_PUBLIC.replace(/\/+$/, '');
  const g = (process.env.GO2RTC_PUBLIC || '').replace(/\/+$/, '');
  return g ? g.replace(/\/go2rtc$/, '/mediamtx') : '';
}

function probeCodec(rtsp: string): Promise<string> {
  if (codecCache.has(rtsp)) return Promise.resolve(codecCache.get(rtsp) as string);
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', rtsp];
    try {
      execFile(FFPROBE, args, { timeout: 9000 }, (_err, stdout) => {
        const codec = String(stdout || '').trim().toLowerCase().split('\n')[0] || '';
        if (codec) codecCache.set(rtsp, codec);
        resolve(codec);
      });
    } catch { resolve(''); }
  });
}

function runOnDemand(rtsp: string, codec: string): string {
  const out = 'rtsp://localhost:18554/$MTX_PATH';
  if (codec === 'h264') {
    return `ffmpeg -rtsp_transport tcp -i ${rtsp} -c:v copy -an -f rtsp ${out}`;
  }
  return `ffmpeg -rtsp_transport tcp -i ${rtsp} -c:v libx264 -vf scale=1280:720 ` +
    `-preset superfast -tune zerolatency -g 50 -pix_fmt yuv420p -an -f rtsp ${out}`;
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

  const codec = await probeCodec(rtsp);
  const body = JSON.stringify({
    runOnDemand: runOnDemand(rtsp, codec),
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
