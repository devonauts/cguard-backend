import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Real-time visitor feed for the supervisor "Visitors" screen — every visitor
 * across the tenant's stations with a derived status, the visitor's photo
 * (face → ID), company/host/badge/vehicle, and check-in/out times, plus status
 * counts. Read-only, gated `supervisorMe`.
 *
 * The model has no `status` column, so it's derived:
 *   checkedOut  — exitTime set
 *   denied      — reason marks a denial and no entry
 *   expected    — no/future visitDate and not checked out
 *   checkedIn   — visitDate in the past, no exitTime
 */

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function derive(v: any): 'checkedIn' | 'expected' | 'checkedOut' | 'denied' {
  if (v.exitTime) return 'checkedOut';
  const reason = String(v.reason || '').toLowerCase();
  const vd = v.visitDate ? new Date(v.visitDate).getTime() : 0;
  if (!vd && /deneg|rechaz|denied|no autoriz|denad/.test(reason)) return 'denied';
  if (/deneg|rechaz|denied|no autoriz|denad/.test(reason) && !vd) return 'denied';
  if (!vd || vd > Date.now() + 60_000) return 'expected';
  return 'checkedIn';
}

/** GET /tenant/:tenantId/supervisor/me/visitors */
export const getVisitors = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const Op = db.Sequelize.Op;
    const tenantId = req.currentTenant.id;

    // Active (not checked out) + everything from today.
    const rows = await db.visitorLog.findAll({
      where: {
        tenantId,
        archived: { [Op.or]: [false, null] },
        // Show: still-onsite (no exit) · arrived today · checked out today. The
        // last case keeps a just-checked-out visitor (who arrived earlier) in the
        // Checked Out tab instead of dropping them from the feed.
        [Op.or]: [
          { exitTime: null },
          { visitDate: { [Op.gte]: startOfToday() } },
          { exitTime: { [Op.gte]: startOfToday() } },
        ],
      },
      attributes: [
        'id', 'firstName', 'lastName', 'company', 'personVisited', 'tagNumber',
        'vehiclePlate', 'vehicleType', 'visitDate', 'exitTime', 'reason', 'idNumber',
        'stationId', 'stationName',
      ],
      include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'], required: false }],
      order: [['visitDate', 'DESC']],
      limit: 300,
    });

    // Visitor photos live in the polymorphic files table (no model relation).
    const ids = rows.map((r: any) => String(r.id));
    const photoByVisitor = new Map<string, any>();
    if (ids.length) {
      try {
        const files = await db.file.findAll({
          where: {
            tenantId,
            belongsTo: db.visitorLog.getTableName(),
            belongsToColumn: { [Op.in]: ['facePhoto', 'idPhoto'] },
            belongsToId: { [Op.in]: ids },
          },
        });
        // Prefer facePhoto over idPhoto.
        const byId = new Map<string, { face?: any; id?: any }>();
        files.forEach((f: any) => {
          const k = String(f.belongsToId);
          const slot = byId.get(k) || {};
          if (f.belongsToColumn === 'facePhoto' && !slot.face) slot.face = f;
          else if (f.belongsToColumn === 'idPhoto' && !slot.id) slot.id = f;
          byId.set(k, slot);
        });
        for (const [k, slot] of byId) {
          const file = slot.face || slot.id;
          if (file) {
            const filled = await FileRepository.fillDownloadUrl([file]);
            photoByVisitor.set(k, filled[0] || null);
          }
        }
      } catch {
        /* photos best-effort */
      }
    }

    const visitors = rows.map((r: any) => {
      const id = String(r.id);
      const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.vehiclePlate || '—';
      const vehicle = r.vehiclePlate
        ? `${r.vehiclePlate}${r.vehicleType ? ` (${r.vehicleType})` : ''}`
        : null;
      return {
        id,
        name,
        company: r.company || null,
        host: r.personVisited || null,
        badge: r.tagNumber ? String(r.tagNumber) : null,
        vehicle,
        idNumber: r.idNumber || null,
        reason: r.reason || null,
        station: (r.station ? r.station.stationName : null) || r.stationName || null,
        status: derive(r),
        checkInAt: r.visitDate || null,
        checkOutAt: r.exitTime || null,
        photo: photoByVisitor.get(id) || null,
      };
    });

    const summary = {
      all: visitors.length,
      checkedIn: visitors.filter((v) => v.status === 'checkedIn').length,
      expected: visitors.filter((v) => v.status === 'expected').length,
      checkedOut: visitors.filter((v) => v.status === 'checkedOut').length,
      denied: visitors.filter((v) => v.status === 'denied').length,
    };

    await ApiResponseHandler.success(req, res, { visitors, summary });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export default getVisitors;
