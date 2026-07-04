import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Full visitor detail for the supervisor "Visitor Details" screen + a check-out
 * action. The visitorLog model is limited, so fields the mock shows but the
 * model lacks (email, issuing state, department, access level, color, parking,
 * NDA) come back null and the app renders "—". Read-only + checkout, gated
 * `supervisorMe`.
 */

function ref(id: string, createdAt: any): string {
  const year = new Date(createdAt || Date.now()).getFullYear();
  let n = 0;
  for (const c of String(id)) n = (n * 31 + c.charCodeAt(0)) % 10000;
  return `VIS-${year}-${String(n).padStart(4, '0')}`;
}

function derive(v: any): 'checkedIn' | 'expected' | 'checkedOut' | 'denied' {
  if (v.exitTime) return 'checkedOut';
  const reason = String(v.reason || '').toLowerCase();
  const vd = v.visitDate ? new Date(v.visitDate).getTime() : 0;
  if (!vd && /deneg|rechaz|denied|no autoriz|denad/.test(reason)) return 'denied';
  if (!vd || vd > Date.now() + 60_000) return 'expected';
  return 'checkedIn';
}

/** All facePhoto/idPhoto files for a visitor from the polymorphic files table. */
async function visitorPhotos(db: any, tenantId: string, id: string) {
  const Op = db.Sequelize.Op;
  try {
    const files = await db.file.findAll({
      where: {
        tenantId,
        belongsTo: db.visitorLog.getTableName(),
        belongsToColumn: { [Op.in]: ['facePhoto', 'idPhoto'] },
        belongsToId: id,
      },
    });
    const filled = files.length ? await FileRepository.fillDownloadUrl(files) : [];
    const face = filled.filter((f: any) => f.belongsToColumn === 'facePhoto');
    const idDocs = filled.filter((f: any) => f.belongsToColumn === 'idPhoto');
    return { face, idDocs };
  } catch {
    return { face: [], idDocs: [] };
  }
}

async function load(db: any, tenantId: string, id: string) {
  return db.visitorLog.findOne({
    where: { id, tenantId },
    include: [{ model: db.station, as: 'station', attributes: ['id', 'stationName'], required: false }],
  });
}

/** GET /tenant/:tenantId/supervisor/me/visitors/:visitorId */
export const getVisitorDetail = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const r = await load(db, tenantId, String(req.params.visitorId));
    if (!r) return ApiResponseHandler.success(req, res, { visitor: null });

    const id = String(r.id);
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.vehiclePlate || '—';
    const status = derive(r);
    const location = (r.station ? r.station.stationName : null) || r.stationName || null;
    const { face, idDocs } = await visitorPhotos(db, tenantId, id);
    const photo = face[0] || idDocs[0] || null;

    // Documents = visitor photo + ID document(s).
    const documents: any[] = [];
    if (face[0]) documents.push({ kind: 'photo', name: 'Visitor Photo', file: face[0] });
    idDocs.forEach((f: any) => documents.push({ kind: 'id', name: 'ID Document', file: f }));

    // Timeline (synthesized from what's stored).
    const timeline: any[] = [];
    if (r.createdAt && r.visitDate && new Date(r.createdAt) < new Date(r.visitDate)) {
      timeline.push({ type: 'registered', title: 'Pre-registered', at: r.createdAt });
    }
    if (r.visitDate) timeline.push({ type: 'checkin', title: `Checked In${location ? ` at ${location}` : ''}`, at: r.visitDate, photo: face[0] || null });
    if (r.tagNumber) timeline.push({ type: 'badge', title: 'Badge Issued', at: r.visitDate, detail: `#${r.tagNumber}` });
    if (r.personVisited) timeline.push({ type: 'host', title: 'Met with Host', at: r.visitDate, detail: r.personVisited });
    if (r.exitTime) timeline.push({ type: 'checkout', title: 'Checked Out', at: r.exitTime });
    timeline.sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());

    await ApiResponseHandler.success(req, res, {
      visitor: {
        id,
        name,
        reference: ref(id, r.createdAt),
        status,
        photo,
        phone: r.phone || null,
        email: r.email || null,
        company: r.company || null,
        idType: r.idType || null,
        idNumber: r.idNumber || null,
        issuingState: r.issuingState || null,
        visitType: r.visitType || r.placeType || null,
        checkInAt: r.visitDate || null,
        checkOutAt: r.exitTime || null,
        visit: {
          purpose: r.reason || null,
          location,
          host: r.personVisited || null,
          department: r.department || null,
          accessLevel: r.accessLevel || null,
          preRegistered: r.createdAt && r.visitDate && new Date(r.createdAt) < new Date(r.visitDate) ? true : null,
          expectedDuration: r.expectedDuration || null,
          notes: r.notes || r.reason || null,
        },
        vehicle: r.vehiclePlate || r.vehicleType || r.vehicleMakeModel ? {
          vehicle: r.vehicleType || r.vehicleMakeModel || null,
          plate: r.vehiclePlate || null,
          color: r.vehicleColor || null,
          makeModel: r.vehicleMakeModel || r.vehicleType || null,
          parking: r.parkingLocation || null,
        } : null,
        peopleOnsite: Number(r.numPeople) || 1,
        badge: r.tagNumber ? `#${r.tagNumber}` : null,
        timeline,
        documents,
      },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/supervisor/me/visitors/:visitorId/checkout */
export const checkoutVisitor = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const r = await load(db, tenantId, String(req.params.visitorId));
    if (!r) throw new Error400(req.language);
    if (!r.exitTime) {
      r.exitTime = new Date();
      await r.save();
    }
    await ApiResponseHandler.success(req, res, { visitor: { id: String(r.id), checkOutAt: r.exitTime } });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
