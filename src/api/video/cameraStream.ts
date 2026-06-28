/**
 * GET /tenant/:tenantId/video/camera/:id/stream
 *
 * Resolves the browser-playable stream for a camera. If a go2rtc media gateway is
 * configured (env GO2RTC_API + GO2RTC_PUBLIC), the camera's RTSP is registered with
 * go2rtc on demand (server-side — credentials never reach the browser) and a same-
 * origin HLS url is returned. Otherwise falls back to the camera's manual streamUrl.
 *
 * Response: { type: 'hls'|'webrtc'|'none', url: string|null, snapshotUrl: string|null }
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';
import { buildRtspUrl, streamName, relayPullUrl } from './_videoUrl';

const GO2RTC_API = process.env.GO2RTC_API || '';        // e.g. http://127.0.0.1:1984
const GO2RTC_PUBLIC = process.env.GO2RTC_PUBLIC || '';  // e.g. https://app.cguardpro.com/go2rtc

async function registerWithGo2rtc(name: string, rtsp: string): Promise<boolean> {
  try {
    const u = `${GO2RTC_API.replace(/\/+$/, '')}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(rtsp)}`;
    const r = await (fetch as any)(u, { method: 'PUT' });
    return !!(r && r.ok);
  } catch (e: any) {
    console.warn('[video] go2rtc register failed:', e?.message || e);
    return false;
  }
}

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const camera = await db.videoCamera.findOne({
      where: { id: req.params.id, tenantId },
      include: [{ model: db.videoDevice, as: 'device', required: false }],
    });
    if (!camera) throw new Error404();

    const snapshotUrl = camera.snapshotUrl || null;

    // For a RELAY device the LAN RTSP is unreachable; go2rtc must instead pull from
    // the cloud ingest path the remote site publishes into (relay/<siteKey>/chN).
    let relaySrc: string | null = null;
    if (camera.device && camera.device.connectionMode === 'relay' && camera.device.relaySiteId) {
      const site = await db.videoRelaySite.findOne({
        where: { id: camera.device.relaySiteId, tenantId },
      });
      if (site) relaySrc = relayPullUrl(site, camera.channel);
    }

    // Preferred path: go2rtc gateway. Register the source (relay ingest for remote
    // devices, otherwise the brand-aware LAN RTSP) under a stable, opaque name and
    // hand the browser only that name.
    if (GO2RTC_API && GO2RTC_PUBLIC) {
      let rtsp = relaySrc || camera.rtspUrl || (camera.device ? buildRtspUrl(camera.device, camera.channel) : null);
      if (rtsp) {
        const name = streamName(camera.id);
        // Browsers can't decode H265/HEVC (which these DVRs output) over MSE — and
        // WebRTC is H264-only — so the picture stays black. Transcode to H264/AAC via
        // ffmpeg. Use the lower-res SUB stream (sN/s1) for the live wall so each camera
        // costs ~10% of a core (9 cams fit comfortably on the box). Relay sources and
        // already-wrapped (ffmpeg:/#) sources are left as-is.
        if (!relaySrc) rtsp = rtsp.replace('/s0/live', '/s1/live');
        const src = (rtsp.startsWith('ffmpeg:') || rtsp.includes('#video='))
          ? rtsp
          : `ffmpeg:${rtsp}#video=h264#audio=aac`;
        const ok = await registerWithGo2rtc(name, src);
        const base = GO2RTC_PUBLIC.replace(/\/+$/, '');
        const url = `${base}/api/stream.m3u8?src=${name}`;
        // Multi-protocol: the go2rtc player engine negotiates WebRTC → MSE → HLS.
        // ws is same-origin through the nginx /go2rtc proxy (WebSocket upgrade is on),
        // so MSE works with no extra ports; WebRTC kicks in when reachable.
        const ws = `${base.replace(/^http/i, 'ws')}/api/ws?src=${name}`;
        if (!camera.streamUrl || camera.streamUrl !== url) {
          try { await camera.update({ streamUrl: url }); } catch { /* ignore */ }
        }
        return ApiResponseHandler.success(req, res, {
          type: 'go2rtc', src: name, ws, url, mode: 'webrtc,mse,hls', gateway: base,
          snapshotUrl, registered: ok,
        });
      }
    }

    // Fallback: manually-configured streamUrl.
    const url = camera.streamUrl || null;
    let type: 'hls' | 'webrtc' | 'none' = 'none';
    if (url) {
      const protocol = (camera.device && camera.device.protocol) || '';
      type = (protocol === 'webrtc' || /^webrtc:/i.test(url)) ? 'webrtc' : 'hls';
    }
    await ApiResponseHandler.success(req, res, { type, url, snapshotUrl });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
