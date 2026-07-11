import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { dispatch } from '../../lib/notificationDispatcher';
import { haversineDistance } from '../../lib/geofence';

/**
 * Staff (administrative / office) self-attendance — the web time clock for
 * users who have no securityGuard row and no station. Writes staffShift rows,
 * folded into Nómina › Registros de Asistencia (role='administrative').
 *
 * Mirrors the supervisor clock, plus an OPTIONAL per-user office geofence:
 * when the user has officeLatitude/Longitude set, the punch distance is
 * validated + recorded; otherwise it's a free-form punch.
 */

const DEFAULT_OFFICE_RADIUS_M = 150;

/** Resolve the punch's office-geofence outcome for the current user. */
function evalOfficeGeofence(
  user: any,
  lat: any,
  lng: any,
): { distanceM: number | null; outside: boolean | null; blocked: boolean; radiusM: number | null } {
  const oLat = user?.officeLatitude != null ? Number(user.officeLatitude) : null;
  const oLng = user?.officeLongitude != null ? Number(user.officeLongitude) : null;
  if (oLat == null || oLng == null || Number.isNaN(oLat) || Number.isNaN(oLng)) {
    return { distanceM: null, outside: null, blocked: false, radiusM: null }; // no office set → free-form
  }
  const radiusM = Number(user.officeGeofenceRadiusM) > 0 ? Number(user.officeGeofenceRadiusM) : DEFAULT_OFFICE_RADIUS_M;
  if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
    // Office set but no coords → can't validate; record null, don't block.
    return { distanceM: null, outside: null, blocked: false, radiusM };
  }
  const distanceM = Math.round(haversineDistance(Number(lat), Number(lng), oLat, oLng));
  const outside = distanceM > radiusM;
  return { distanceM, outside, blocked: outside, radiusM };
}

function breakStats(breaks: any): { breaks: any[]; onBreak: boolean; breakMinutes: number } {
  const arr = Array.isArray(breaks) ? breaks : [];
  const last = arr[arr.length - 1];
  const onBreak = !!last && !last.end;
  let ms = 0;
  for (const b of arr) {
    const start = b?.start ? new Date(b.start).getTime() : 0;
    const end = b?.end ? new Date(b.end).getTime() : Date.now();
    if (start) ms += Math.max(0, end - start);
  }
  return { breaks: arr, onBreak, breakMinutes: Math.round(ms / 60000) };
}

function serializeShift(shift: any) {
  if (!shift) return null;
  const s = shift.get ? shift.get({ plain: true }) : shift;
  const bs = breakStats(s.breaks);
  return {
    id: s.id,
    punchInTime: s.punchInTime,
    punchInLat: s.punchInLat,
    punchInLng: s.punchInLng,
    punchOutTime: s.punchOutTime,
    punchOutLat: s.punchOutLat,
    punchOutLng: s.punchOutLng,
    observations: s.observations,
    punchInPhoto: s.punchInPhoto,
    punchInAddress: s.punchInAddress,
    punchInBattery: s.punchInBattery,
    punchOutPhoto: s.punchOutPhoto,
    punchOutAddress: s.punchOutAddress,
    punchInDistanceM: s.punchInDistanceM,
    punchInOutsideGeofence: s.punchInOutsideGeofence,
    breaks: bs.breaks,
    onBreak: bs.onBreak,
    breakMinutes: bs.breakMinutes,
    hoursWorked: s.hoursWorked != null ? Number(s.hoursWorked) : null,
  };
}

async function findOpenShift(db: any, tenantId: string, userId: string) {
  return db.staffShift.findOne({
    where: { tenantId, userId, punchOutTime: null },
    order: [['punchInTime', 'DESC']],
  });
}

async function propagateStaffClock(
  db: any, tenantId: string, userId: string, kind: 'in' | 'out', shiftId: string, actorName?: string,
  extra?: { coords?: { lat: any; lng: any }; photoUrl?: string; address?: string; time?: Date; hoursWorked?: number | null; observations?: string | null },
): Promise<void> {
  try {
    const when = extra?.time || new Date();
    const timeLabel = when.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });
    await dispatch(
      kind === 'in' ? 'staff.checkin' : 'staff.checkout',
      {
        staffUserId: userId,
        staffName: actorName || 'Administrativo',
        kind,
        photoUrl: extra?.photoUrl || null,
        address: extra?.address || null,
        latitude: extra?.coords?.lat ?? null,
        longitude: extra?.coords?.lng ?? null,
        clockInTime: kind === 'in' ? timeLabel : undefined,
        clockOutTime: kind === 'out' ? timeLabel : undefined,
        hoursWorked: extra?.hoursWorked ?? null,
        observations: extra?.observations || null,
      },
      { database: db, tenantId, sourceEntityType: 'staffShift', sourceEntityId: shiftId },
    );
  } catch { /* realtime is best-effort */ }
}

/** GET /tenant/:tenantId/staff/me — status + office-location config for the kiosk. */
export const getStatus = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.staffMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const user = req.currentUser;
    const shift = await findOpenShift(db, tenantId, user.id);
    const hasOffice = user.officeLatitude != null && user.officeLongitude != null;
    await ApiResponseHandler.success(req, res, {
      isClockedIn: !!shift,
      shift: serializeShift(shift),
      office: hasOffice
        ? {
            latitude: Number(user.officeLatitude),
            longitude: Number(user.officeLongitude),
            radiusM: Number(user.officeGeofenceRadiusM) > 0 ? Number(user.officeGeofenceRadiusM) : DEFAULT_OFFICE_RADIUS_M,
            address: user.officeAddress || null,
          }
        : null,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/staff/me/clock-in */
export const clockIn = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.staffMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const user = req.currentUser;
    const userId = user.id;
    const data = (req.body && req.body.data) || req.body || {};

    const existing = await findOpenShift(db, tenantId, userId);
    if (existing) {
      return ApiResponseHandler.success(req, res, { shift: serializeShift(existing) });
    }

    const geo = evalOfficeGeofence(user, data.latitude, data.longitude);
    if (geo.blocked) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'geofence_failed',
        message: `Estás a ${geo.distanceM}m de tu oficina. Máximo permitido: ${geo.radiusM}m.`,
        distance: geo.distanceM,
        maxRadius: geo.radiusM,
      });
    }

    const now = new Date();
    const shift = await db.staffShift.create({
      tenantId,
      userId,
      punchInTime: now,
      punchInLat: data.latitude ?? null,
      punchInLng: data.longitude ?? null,
      punchInPhoto: data.selfiePhoto ?? null,
      punchInAddress: data.address ?? null,
      punchInBattery: data.battery ?? null,
      punchInChecklist: data.checklist != null ? JSON.stringify(data.checklist) : null,
      punchInDistanceM: geo.distanceM,
      punchInOutsideGeofence: geo.outside,
      status: 'no_schedule',
      lateMinutes: 0,
    });

    await propagateStaffClock(db, tenantId, userId, 'in', shift.id, user?.fullName || user?.email, {
      coords: { lat: data.latitude, lng: data.longitude },
      photoUrl: typeof data.selfiePhoto === 'string' ? data.selfiePhoto : null,
      address: data.address || null,
      time: now,
    });

    await ApiResponseHandler.success(req, res, { success: true, shift: serializeShift(shift) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/staff/me/clock-out */
export const clockOut = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.staffMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const user = req.currentUser;
    const userId = user.id;
    const data = (req.body && req.body.data) || req.body || {};

    const shift = await findOpenShift(db, tenantId, userId);
    if (!shift) {
      return ApiResponseHandler.success(req, res, { shift: null, alreadyOut: true });
    }

    const now = new Date();
    const arr: any[] = Array.isArray(shift.breaks) ? shift.breaks : [];
    const li = arr.length - 1;
    const breaks = arr.map((b, k) => (k === li && !b.end ? { ...b, end: now.toISOString() } : { ...b }));

    const grossMs = now.getTime() - new Date(shift.punchInTime).getTime();
    let breakMs = 0;
    for (const b of breaks) {
      const st = b.start ? new Date(b.start).getTime() : 0;
      const en = b.end ? new Date(b.end).getTime() : now.getTime();
      if (st) breakMs += Math.max(0, en - st);
    }
    const hoursWorked = Math.round((Math.max(0, grossMs - breakMs) / 3_600_000) * 100) / 100;

    const geo = evalOfficeGeofence(user, data.latitude, data.longitude);

    await shift.update({
      punchOutTime: now,
      punchOutLat: data.latitude ?? null,
      punchOutLng: data.longitude ?? null,
      punchOutPhoto: data.selfiePhoto ?? null,
      punchOutAddress: data.address ?? null,
      punchOutDistanceM: geo.distanceM,
      punchOutOutsideGeofence: geo.outside,
      observations: data.observations ?? null,
      breaks,
      hoursWorked,
    });

    await propagateStaffClock(db, tenantId, userId, 'out', shift.id, user?.fullName || user?.email, {
      coords: { lat: data.latitude, lng: data.longitude },
      photoUrl: typeof data.selfiePhoto === 'string' ? data.selfiePhoto : null,
      address: data.address || null,
      time: now,
      hoursWorked,
      observations: data.observations || null,
    });

    await ApiResponseHandler.success(req, res, { success: true, shift: serializeShift(shift) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/staff/me/break/start */
export const breakStart = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.staffMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const shift = await findOpenShift(db, tenantId, req.currentUser.id);
    if (!shift) return ApiResponseHandler.success(req, res, { shift: null });
    const breaks = Array.isArray(shift.breaks) ? [...shift.breaks] : [];
    const last = breaks[breaks.length - 1];
    if (!last || last.end) {
      breaks.push({ start: new Date().toISOString(), end: null });
      await shift.update({ breaks });
    }
    await ApiResponseHandler.success(req, res, { shift: serializeShift(shift) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/staff/me/break/end */
export const breakEnd = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.staffMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const shift = await findOpenShift(db, tenantId, req.currentUser.id);
    if (!shift) return ApiResponseHandler.success(req, res, { shift: null });
    const arr: any[] = Array.isArray(shift.breaks) ? shift.breaks : [];
    const i = arr.length - 1;
    if (i >= 0 && !arr[i].end) {
      const breaks = arr.map((b, k) => (k === i ? { ...b, end: new Date().toISOString() } : { ...b }));
      await shift.update({ breaks });
    }
    const fresh = await findOpenShift(db, tenantId, req.currentUser.id);
    await ApiResponseHandler.success(req, res, { shift: serializeShift(fresh || shift) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
