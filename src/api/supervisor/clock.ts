import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';
import { fileOptionsFor } from './helpers';
import { storePlatformEvent } from '../../lib/platformEventStore';

/**
 * De-island the supervisor clock: mirror on-duty onto the supervisorProfile and
 * notify the CRM (bell + activity feed) so a supervisor punch propagates the
 * same way a guard punch does. Best-effort — never breaks the clock action.
 */
async function propagateSupervisorClock(
  db: any, tenantId: string, userId: string, kind: 'in' | 'out', shiftId: string, actorName?: string,
): Promise<void> {
  try {
    await db.supervisorProfile.update(
      { isOnDuty: kind === 'in' },
      { where: { tenantId, supervisorUserId: userId } },
    );
  } catch { /* profile may not exist yet — CRM list lazy-creates it */ }
  try {
    const name = actorName || 'Supervisor';
    await storePlatformEvent(db, {
      tenantId,
      eventType: kind === 'in' ? 'supervisor.checkin' : 'supervisor.checkout',
      title: kind === 'in' ? 'Supervisor en turno' : 'Supervisor fuera de turno',
      body: name,
      targetRoles: 'admin,operationsManager',
      sourceEntityType: 'supervisorShift',
      sourceEntityId: shiftId,
      payload: { supervisorUserId: userId, kind },
    });
  } catch { /* realtime is best-effort */ }
}

/** Serialize a supervisorShift row for the app. */
function serializeShift(shift: any) {
  if (!shift) return null;
  const s = shift.get ? shift.get({ plain: true }) : shift;
  return {
    id: s.id,
    punchInTime: s.punchInTime,
    punchInLat: s.punchInLat,
    punchInLng: s.punchInLng,
    punchOutTime: s.punchOutTime,
    punchOutLat: s.punchOutLat,
    punchOutLng: s.punchOutLng,
    observations: s.observations,
  };
}

async function findOpenShift(db: any, tenantId: string, userId: string) {
  return db.supervisorShift.findOne({
    where: { tenantId, supervisorUserId: userId, punchOutTime: null },
    order: [['punchInTime', 'DESC']],
  });
}

/** GET /supervisor/me/clock */
export const getClock = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const shift = await findOpenShift(db, tenantId, req.currentUser.id);
    await ApiResponseHandler.success(req, res, {
      clockedIn: !!shift,
      shift: serializeShift(shift),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /supervisor/me/clock-in { latitude, longitude, selfiePhoto? } */
export const clockIn = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const data = (req.body && req.body.data) || req.body || {};

    const existing = await findOpenShift(db, tenantId, userId);
    if (existing) {
      // Idempotent: already clocked in → return the open shift.
      return ApiResponseHandler.success(req, res, { shift: serializeShift(existing) });
    }

    // Stamp the scheduled turno window this punch is for (from the supervisor's
    // turno config), so we can measure punctuality + force-close an overrun.
    const now = new Date();
    const attendance: any = { status: 'no_schedule', lateMinutes: 0 };
    try {
      // Punctuality is measured against the generated schedule of the puesto the
      // supervisor is assigned to (the schedule lives on the position, not the user).
      const { scheduledShiftAt } = require('../../services/supervisorScheduleService');
      const w = await scheduledShiftAt(db, tenantId, userId, now);
      if (w) {
        attendance.scheduledStart = w.startTime;
        attendance.scheduledEnd = w.endTime;
        attendance.shiftKind = w.shiftKind;
        const lateMs = now.getTime() - new Date(w.startTime).getTime();
        const GRACE_MS = 5 * 60_000;
        attendance.status = lateMs > GRACE_MS ? 'late' : 'on_time';
        attendance.lateMinutes = lateMs > GRACE_MS ? Math.round(lateMs / 60_000) : 0;
      }
    } catch { /* schedule stamping is best-effort */ }

    const shift = await db.supervisorShift.create({
      tenantId,
      supervisorUserId: userId,
      punchInTime: now,
      punchInLat: data.latitude ?? null,
      punchInLng: data.longitude ?? null,
      ...attendance,
    });

    // Optional selfie captured at clock-in (uploaded via the credentials flow,
    // posted back as a stored file descriptor). Best-effort — never 500s.
    const selfie = data.selfiePhoto;
    if (selfie) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const FileRepository = require('../../database/repositories/fileRepository').default;
        await FileRepository.replaceRelationFiles(
          {
            belongsTo: db.supervisorShift.getTableName(),
            belongsToColumn: 'selfie',
            belongsToId: shift.id,
          },
          Array.isArray(selfie) ? selfie : [selfie],
          fileOptionsFor(req),
        );
      } catch (e: any) {
        console.warn('[supervisor.clockIn] selfie link failed:', e?.message || e);
      }
    }

    await propagateSupervisorClock(db, tenantId, userId, 'in', shift.id, req.currentUser?.fullName || req.currentUser?.email);

    await ApiResponseHandler.success(req, res, { shift: serializeShift(shift) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /supervisor/me/clock-out { latitude, longitude, observations? } */
export const clockOut = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.supervisorMe);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const userId = req.currentUser.id;
    const data = (req.body && req.body.data) || req.body || {};

    const shift = await findOpenShift(db, tenantId, userId);
    if (!shift) throw new Error400(req.language);

    await shift.update({
      punchOutTime: new Date(),
      punchOutLat: data.latitude ?? null,
      punchOutLng: data.longitude ?? null,
      observations: data.observations ?? null,
    });

    await propagateSupervisorClock(db, tenantId, userId, 'out', shift.id, req.currentUser?.fullName || req.currentUser?.email);

    await ApiResponseHandler.success(req, res, { shift: serializeShift(shift) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
