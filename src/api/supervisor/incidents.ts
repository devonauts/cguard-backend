import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Incidents list for the supervisor app's Incidents screen — image-forward
 * cards + status/severity summaries. Returns each incident's first photo (with
 * a resolved downloadUrl), station+post location, guard, normalized severity +
 * status, and timestamp, plus status and severity counts. Read-only, gated
 * `supervisorMe`.
 */

function normSeverity(v: any): 'critical' | 'high' | 'medium' | 'low' {
  const s = String(v || '').trim().toLowerCase();
  if (['critical', 'critico', 'crítico', 'urgent', 'urgente'].includes(s)) return 'critical';
  if (['high', 'alto', 'alta'].includes(s)) return 'high';
  if (['low', 'bajo', 'baja'].includes(s)) return 'low';
  return 'medium';
}

function normStatus(v: any): 'open' | 'inProgress' | 'resolved' | 'closed' {
  const s = String(v || '').trim().toLowerCase();
  if (['closed', 'cerrado', 'cerrada'].includes(s)) return 'closed';
  if (['resolved', 'resuelto', 'resuelta'].includes(s)) return 'resolved';
  if (['in_progress', 'inprogress', 'en proceso', 'en_proceso', 'proceso'].includes(s)) return 'inProgress';
  return 'open';
}

/** GET /tenant/:tenantId/supervisor/me/incidents */
export const getIncidents = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const rows = await db.incident.findAll({
      where: { tenantId },
      attributes: [
        'id', 'subject', 'content', 'priority', 'status', 'location',
        'dateTime', 'incidentAt', 'createdAt', 'stationId', 'postSiteId', 'guardNameId',
      ],
      include: [
        { model: db.station, as: 'station', attributes: ['id', 'stationName'], required: false },
        { model: db.businessInfo, as: 'site', attributes: ['id', 'companyName'], required: false },
        { model: db.securityGuard, as: 'guardName', attributes: ['id', 'fullName'], required: false },
        { model: db.incidentType, as: 'incidentType', attributes: ['id', 'name'], required: false },
        { model: db.file, as: 'imageUrl', required: false },
      ],
      order: [['createdAt', 'DESC']],
      limit: 300,
    });

    const incidents = await Promise.all(
      rows.map(async (r: any) => {
        const stationName = r.station ? r.station.stationName : null;
        // The incident `location` field sometimes holds raw "lat,lng" coords
        // (GPS-stamped reports) — don't surface those; prefer the post-site name.
        const rawSub = r.location ? String(r.location).trim() : '';
        const looksLikeCoords = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(rawSub);
        const sub = (looksLikeCoords ? '' : rawSub) || (r.site ? r.site.companyName : null);
        const location = [stationName, sub].filter(Boolean).join(' – ') || sub || stationName || null;

        let photo: any = null;
        let photoCount = 0;
        try {
          if (Array.isArray(r.imageUrl) && r.imageUrl.length) {
            photoCount = r.imageUrl.length;
            const filled = await FileRepository.fillDownloadUrl([r.imageUrl[0]]);
            photo = filled[0] || null;
          }
        } catch {
          photo = null;
        }

        return {
          id: String(r.id),
          title: r.subject || (r.incidentType ? r.incidentType.name : null) || 'Incidente',
          severity: normSeverity(r.priority),
          status: normStatus(r.status),
          location,
          guard: r.guardName ? r.guardName.fullName : null,
          at: r.incidentAt || r.dateTime || r.createdAt,
          photo,
          photoCount,
        };
      }),
    );

    const summary = {
      all: incidents.length,
      open: incidents.filter((i) => i.status === 'open').length,
      inProgress: incidents.filter((i) => i.status === 'inProgress').length,
      resolved: incidents.filter((i) => i.status === 'resolved' || i.status === 'closed').length,
    };
    const bySeverity = {
      critical: incidents.filter((i) => i.severity === 'critical').length,
      high: incidents.filter((i) => i.severity === 'high').length,
      medium: incidents.filter((i) => i.severity === 'medium').length,
      low: incidents.filter((i) => i.severity === 'low').length,
    };

    await ApiResponseHandler.success(req, res, { incidents, summary, bySeverity });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getIncidents;
