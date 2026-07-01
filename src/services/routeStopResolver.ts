/**
 * routeStopResolver — turns a route stop (routePoint) into a concrete
 * { name, address, lat, lng } by looking at its `siteType` + `siteId`.
 *
 * Each stop references a different kind of record (a station, a business/post
 * site, a client account, a guard, or an alarm panel). This centralises the
 * per-type coordinate/name lookup so the supervisor route endpoints always
 * hand the mobile app real coordinates, falling back to the point's own
 * stored lat/lng/address when the referenced record has none.
 */

export interface ResolvedStop {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Merge a resolved record's values over the point's own fallbacks. Any missing
 * coordinate/address on the record falls back to the point.
 */
function withFallback(point: any, resolved: Partial<ResolvedStop>): ResolvedStop {
  const pLat = num(point?.lat);
  const pLng = num(point?.lng);
  return {
    name: resolved.name || point?.name || null,
    address: resolved.address ?? point?.address ?? null,
    lat: resolved.lat ?? pLat,
    lng: resolved.lng ?? pLng,
  };
}

export async function resolveStop(db: any, tenantId: string, point: any): Promise<ResolvedStop> {
  const siteType: string = (point?.siteType || 'station').toString();
  const siteId = point?.siteId;

  if (!siteId) {
    return withFallback(point, {});
  }

  try {
    switch (siteType) {
      case 'station': {
        const rec = await db.station.findOne({ where: { id: siteId, tenantId } });
        if (!rec) break;
        return withFallback(point, {
          name: rec.nickname || rec.stationName || null,
          // station has no address column of its own → use the point's.
          address: point?.address ?? null,
          lat: num(rec.latitud),
          lng: num(rec.longitud),
        });
      }

      case 'businessInfo': {
        const rec = await db.businessInfo.findOne({ where: { id: siteId, tenantId } });
        if (!rec) break;
        return withFallback(point, {
          name: rec.companyName || null,
          address: rec.address || null,
          lat: num(rec.latitud),
          lng: num(rec.longitud),
        });
      }

      case 'client': {
        const rec = await db.clientAccount.findOne({ where: { id: siteId, tenantId } });
        if (!rec) break;
        return withFallback(point, {
          name: rec.commercialName || rec.name || null,
          address: rec.address || null,
          lat: num(rec.latitude),
          lng: num(rec.longitude),
        });
      }

      case 'guard': {
        const rec = await db.securityGuard.findOne({ where: { id: siteId, tenantId } });
        if (!rec) break;
        let lat = num(rec.latitude);
        let lng = num(rec.longitude);
        // No geocoded home coords → fall back to the guard's currently-open
        // shift punch-in location (where they are working right now).
        if (lat === null || lng === null) {
          const openShift = await db.guardShift.findOne({
            where: { guardNameId: siteId, tenantId, punchOutTime: null },
            order: [['punchInTime', 'DESC']],
          });
          if (openShift) {
            lat = lat ?? num(openShift.punchInLatitude);
            lng = lng ?? num(openShift.punchInLongitude);
          }
        }
        return withFallback(point, {
          name: rec.fullName || null,
          address: rec.address || null,
          lat,
          lng,
        });
      }

      case 'alarm': {
        const panel = await db.alarmPanel.findOne({ where: { id: siteId, tenantId } });
        if (!panel) break;
        // Alarm panels have no coords of their own — resolve via the linked
        // station / post-site / client.
        let resolved: ResolvedStop | null = null;
        if (panel.stationId) {
          resolved = await resolveStop(db, tenantId, {
            siteType: 'station',
            siteId: panel.stationId,
          });
        }
        if ((!resolved || resolved.lat === null) && panel.postSiteId) {
          resolved = await resolveStop(db, tenantId, {
            siteType: 'businessInfo',
            siteId: panel.postSiteId,
          });
        }
        if ((!resolved || resolved.lat === null) && panel.customerId) {
          resolved = await resolveStop(db, tenantId, {
            siteType: 'client',
            siteId: panel.customerId,
          });
        }
        return withFallback(point, {
          name: panel.name || resolved?.name || null,
          address: resolved?.address ?? null,
          lat: resolved?.lat ?? null,
          lng: resolved?.lng ?? null,
        });
      }

      default:
        break;
    }
  } catch (e) {
    // Resolution is best-effort; never let a lookup failure break the route.
  }

  return withFallback(point, {});
}
