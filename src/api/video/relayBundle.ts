/**
 * GET /tenant/:tenantId/video/relay-site/:id/bundle
 *
 * Generates a ready-to-run docker-compose for the SITE relay: one ffmpeg service per
 * camera channel that reads the DVR's LAN RTSP locally and PUSHES it OUTBOUND to the
 * cloud ingest at relay/<siteKey>/ch<n> (authenticated with the site's publish token).
 * Stream-copy (no transcode). The tenant runs this on a small always-on box at the
 * site — no inbound ports, works across NAT/countries. go2rtc on the cloud then pulls
 * relay/<siteKey>/ch<n> locally (see relayPullUrl) and serves it through the normal
 * pipeline. Mirrors deviceGatewayConfig.ts.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { decrypt } from '../../lib/secretBox';
import { buildRtspUrl, relayKey } from './_videoUrl';

// Public cloud ingest the site pushes to (Phase 2 infra). Placeholder until set.
const INGEST = (process.env.RELAY_INGEST_PUBLIC || 'rtmps://INGEST_HOST:8443').replace(/\/+$/, '');

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const site = await db.videoRelaySite.findOne({ where: { id: req.params.id, tenantId } });
    if (!site) { const err: any = new Error('Not found'); err.code = 404; throw err; }

    const key = relayKey(site.siteKey);
    const token = decrypt(site.publishToken) || '';

    const devices = await db.videoDevice.findAll({
      where: { tenantId, relaySiteId: site.id, connectionMode: 'relay' },
    });

    // Build one push per channel. (One relay site = one DVR is the common case; if a
    // site has multiple devices their channel numbers must not overlap.)
    const services: string[] = [];
    let count = 0;
    for (const device of devices || []) {
      const channels = Math.max(1, Number(device.channels) || 1);
      for (let ch = 1; ch <= channels; ch++) {
        const lan = buildRtspUrl(device, ch); // decrypts the DVR password internally
        if (!lan) continue;
        const target = `${INGEST}/relay/${key}/ch${ch}?token=${token}`;
        services.push(
          [
            `  ch${ch}:`,
            `    image: jrottenberg/ffmpeg:6-alpine`,
            `    restart: unless-stopped`,
            `    command: >`,
            `      -nostdin -rtsp_transport tcp -i "${lan}"`,
            `      -c copy -f flv "${target}"`,
          ].join('\n'),
        );
        count++;
      }
    }

    const compose =
      `# CGuardPro site relay for "${site.name}" (siteKey: ${key})\n` +
      `# Run on an always-on box at the camera site:  docker compose up -d\n` +
      `# It reads the DVR on the LAN and pushes each channel OUTBOUND to the cloud.\n` +
      `services:\n` +
      (services.length ? services.join('\n') : '  # No relay devices assigned to this site yet.\n');

    await ApiResponseHandler.success(req, res, {
      siteId: site.id,
      siteKey: key,
      ingest: INGEST,
      channelCount: count,
      tokenEmbedded: !!token,
      compose,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
