/**
 * Brand-aware RTSP URL builder + media-gateway (go2rtc) playback URL helpers.
 *
 * Hikvision and Dahua expose well-known RTSP paths. The CRM stores the RTSP url
 * (what the gateway pulls on the LAN) and a streamUrl (what the browser plays —
 * the go2rtc HLS/WebRTC endpoint), since browsers can't play RTSP directly.
 */

function enc(v: any): string {
  return encodeURIComponent(String(v ?? ''));
}

/** Normalize a brand string to a known vendor key. */
export function vendorOf(device: any): 'hikvision' | 'dahua' | 'generic' {
  const b = `${device?.brand || ''} ${device?.model || ''}`.toLowerCase();
  if (/hik|hikvision|ezviz|hilook/.test(b)) return 'hikvision';
  if (/dahua|amcrest|lorex|imou|easy4ip/.test(b)) return 'dahua';
  return 'generic';
}

/**
 * Build the LAN RTSP url for a device channel.
 * @param sub  true = substream (lower bitrate), false = main stream.
 */
export function buildRtspUrl(device: any, channel: number, sub = false): string | null {
  if (!device || !device.host) return null;
  const port = Number(device.port) || 554;
  const auth = device.username ? `${enc(device.username)}:${enc(device.password || '')}@` : '';
  const base = `rtsp://${auth}${device.host}:${port}`;
  const ch = Math.max(1, Number(channel) || 1);
  switch (vendorOf(device)) {
    case 'hikvision':
      // /Streaming/Channels/<channel><01=main|02=sub>  (ch1 main => 101)
      return `${base}/Streaming/Channels/${ch}${sub ? '02' : '01'}`;
    case 'dahua':
      return `${base}/cam/realmonitor?channel=${ch}&subtype=${sub ? 1 : 0}`;
    default:
      // Generic fallback — editable by the operator afterward.
      return `${base}/ch${ch}/${sub ? 'sub' : 'main'}`;
  }
}

/** go2rtc stream name for a camera (stable, no special chars). */
export function streamName(cameraId: string): string {
  return `cam_${String(cameraId).replace(/[^a-zA-Z0-9]/g, '')}`;
}

/**
 * Browser playback url for a camera served by a go2rtc gateway at `base`.
 * go2rtc: HLS at /api/stream.m3u8?src=NAME ; WebRTC (WHEP) at /api/webrtc?src=NAME.
 */
export function gatewayPlaybackUrl(base: string, cameraId: string, format: 'hls' | 'webrtc' = 'hls'): string {
  const b = String(base || '').replace(/\/+$/, '');
  const src = streamName(cameraId);
  return format === 'webrtc'
    ? `${b}/api/webrtc?src=${src}`
    : `${b}/api/stream.m3u8?src=${src}`;
}
