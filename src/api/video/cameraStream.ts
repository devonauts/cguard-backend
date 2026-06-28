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
import { ensureMediamtxPath, mediamtxPublic } from './_mediamtx';

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

    const name = streamName(camera.id);

    // RELAY devices: the LAN RTSP is unreachable, so the remote site publishes into the
    // go2rtc relay ingest. Keep these on go2rtc (transcoded to a browser-safe H264 HLS).
    if (relaySrc && GO2RTC_API && GO2RTC_PUBLIC) {
      const src = (relaySrc.startsWith('ffmpeg:') || relaySrc.includes('#'))
        ? relaySrc : `ffmpeg:${relaySrc}#video=h264#width=1280#height=720#audio=aac`;
      const ok = await registerWithGo2rtc(name, src);
      const base = GO2RTC_PUBLIC.replace(/\/+$/, '');
      const url = `${base}/api/stream.m3u8?src=${name}`;
      return ApiResponseHandler.success(req, res, { type: 'hls', url, gateway: base, snapshotUrl, registered: ok });
    }

    // DIRECT devices: the enterprise path — MediaMTX serves deep-buffer MPEG-TS HLS,
    // copying H264 natively (~2% CPU, full quality) and transcoding only H265 cameras.
    const mtxBase = mediamtxPublic();
    if (mtxBase) {
      const rtsp = camera.rtspUrl || (camera.device ? buildRtspUrl(camera.device, camera.channel) : null);
      if (rtsp) {
        const ok = await ensureMediamtxPath(name, rtsp);
        const url = `${mtxBase}/${name}/index.m3u8`;
        if (!camera.streamUrl || camera.streamUrl !== url) {
          try { await camera.update({ streamUrl: url }); } catch { /* ignore */ }
        }
        // webrtcUrl = same-origin WHEP endpoint → sub-second on the LAN. The player tries
        // it first and falls back to the buffered HLS url when WebRTC can't establish.
        return ApiResponseHandler.success(req, res, {
          type: 'hls', url, webrtcUrl: `/rtc/${name}/whep`, snapshotUrl, registered: ok,
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
