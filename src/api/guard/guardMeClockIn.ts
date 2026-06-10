/**
 * POST /api/tenant/:tenantId/guard/me/clock-in
 * 
 * Guard clocks in. Validates GPS against station geofence.
 * Body: { stationId, latitude, longitude, shiftSchedule?, observations? }
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import { Op } from 'sequelize';
import { dispatch } from '../../lib/notificationDispatcher';
import { gatherClockInContext } from '../../lib/clockInContext';
import {
  clockGate,
  applyClockIn,
  matchScheduledShift,
  findOpenOrShiftRecord,
  hasOpenSession,
  appendSession,
} from '../../services/attendanceService';
import { registerGuardDevice } from '../../services/guardDeviceService';

/** Best-effort client IP from proxy headers / socket. */
function clientIp(req: any): string | null {
  const xf = req.headers?.['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

export default async (req: any, res: any) => {
  try {
    const currentUser = req.currentUser;
    if (!currentUser) throw new Error401();

    const db = req.database;
    const userId = currentUser.id;
    const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);

    const { stationId, latitude, longitude, shiftSchedule, observations,
      selfiePhoto, address, battery, checklist, device } = req.body.data || req.body;

    // Anti-buddy-punching: if the app reports its device identity at clock-in,
    // register it (bind on first use, flag a mismatch). Never blocks the punch.
    if (device && device.deviceId) {
      try {
        await registerGuardDevice(db, tenantId, userId, device);
      } catch (e) {
        console.warn('[clockIn] device register failed:', (e as any)?.message || e);
      }
    }

    // Geofence enforcement is ON in production: location is required and the
    // distance is validated against the station radius. The only escape hatch is
    // the GUARD_GEOFENCE_BYPASS env var (off by default). To clock in from far
    // away without bypassing, set a large station/tenant geofence radius instead.
    const TESTING_FORCE_BYPASS = false;
    const geofenceBypass =
      TESTING_FORCE_BYPASS ||
      ['1', 'true', 'yes', 'on'].includes(
        String(process.env.GUARD_GEOFENCE_BYPASS || '').trim().toLowerCase(),
      );

    if (!stationId) throw new Error400(req.language, 'guard.stationRequired');
    if (!geofenceBypass && (latitude == null || longitude == null)) {
      throw new Error400(req.language, 'guard.locationRequired');
    }

    // Validate station exists
    const station = await db.station.findOne({
      where: { id: stationId, tenantId, deletedAt: null },
    });

    if (!station) {
      throw new Error400(req.language, 'guard.notAssignedToStation');
    }

    // Validate the guard may work this station TODAY. SINGLE SOURCE OF TRUTH =
    // a generated shift covering today (the rotation emits none on a rest day),
    // so a permanently-assigned fijo cannot punch in on their rest day — Phase 7
    // rest enforcement. An active assignment alone is no longer sufficient.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

    const shiftToday = await db.shift.findOne({
      where: {
        guardId: userId, stationId, tenantId,
        startTime: { [Op.lte]: endOfDay },
        endTime: { [Op.gte]: startOfDay },
      },
      attributes: ['id'],
    });
    if (!shiftToday) {
      // Fallback: honor an active assignment ONLY when the guard has no generated
      // shifts at all for this station (generation lag) — never overrides a real
      // rest day, because a rest day still has other-day shifts at the station.
      const anyShift = await db.shift.findOne({
        where: { guardId: userId, stationId, tenantId },
        attributes: ['id'],
      });
      if (anyShift) {
        // Shifts exist but none today → it is a rest day. Block.
        throw new Error400(req.language, 'guard.notAssignedToStation');
      }
      const hasAssignment = await db.guardAssignment.findOne({
        where: { guardId: userId, stationId, tenantId, status: 'active', deletedAt: null },
        attributes: ['id'],
      });
      if (!hasAssignment) {
        throw new Error400(req.language, 'guard.notAssignedToStation');
      }
      // else: assignment exists but zero shifts generated yet → allow (lag).
    }

    // Geofence gate — governed by the tenant's Nómina settings (require
    // validation / allow-outside-with-approval / default radius). Skipped when
    // GUARD_GEOFENCE_BYPASS is on. The distance is computed + recorded either way.
    const gate = await clockGate(db, tenantId, station, latitude, longitude);
    if (!geofenceBypass && gate.blocked) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'geofence_failed',
        message: `Estás a ${gate.geofence.distanceM}m del puesto. Máximo permitido: ${gate.geofence.radiusM}m.`,
        distance: gate.geofence.distanceM,
        maxRadius: gate.geofence.radiusM,
      });
    }
    if (geofenceBypass) {
      console.warn(
        '[clockIn] GUARD_GEOFENCE_BYPASS active — geofence NOT enforced (testing mode).',
      );
    }

    // Find securityGuard record
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    if (!securityGuard) {
      throw new Error400(req.language, 'guard.profileNotFound');
    }

    // ── One attendance record per shift/day (no duplicate rows) ──────────────
    const now = new Date();
    const distanceM = gate.geofence?.distanceM ?? null;
    // Load the tenant once (tz for the day window + email for the notification);
    // reused below by gatherClockInContext so it isn't re-fetched.
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['email', 'timezone'] });
    const tz = tenant?.timezone || 'UTC';

    // Match the scheduled shift so the attendance record is keyed by it; a
    // re-clock-in appends a session to that record instead of creating a new row.
    const match = await matchScheduledShift(db, {
      guardUserId: userId,
      stationId,
      tenantId,
      at: now,
    });

    const existing = await findOpenOrShiftRecord(db, {
      securityGuardId: securityGuard.id,
      stationId,
      shiftId: match.shiftId,
      tenantId,
      tz,
      at: now,
    });

    // Already clocked in (an open session) → reject.
    if (existing && hasOpenSession(existing)) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'already_clocked_in',
        message: 'Ya tienes un registro de entrada activo.',
        activeClockIn: existing.get({ plain: true }),
      });
    }

    const punchMeta = {
      at: now,
      lat: latitude != null ? Number(latitude) : null,
      lng: longitude != null ? Number(longitude) : null,
      photo: selfiePhoto || null,
      address: address ? String(address).slice(0, 512) : null,
      battery:
        battery != null && !isNaN(Number(battery)) ? Math.round(Number(battery)) : null,
      distanceM,
    };

    let guardShiftRecord: any;
    const isReentry = !!existing;
    if (existing) {
      // Re-clock-in within the same shift/day → append a session, reopen.
      guardShiftRecord = existing;
      await existing.update({
        sessions: appendSession(existing, punchMeta),
        punchOutTime: null,
        observations: observations || existing.observations || 'Entrada registrada',
        updatedById: userId,
      });
    } else {
      // First clock-in of this shift/day → create the record with session #1.
      guardShiftRecord = await db.guardShift.create({
        punchInTime: now,
        punchInLatitude: punchMeta.lat,
        punchInLongitude: punchMeta.lng,
        shiftSchedule: shiftSchedule || 'Diurno',
        numberOfPatrolsDuringShift: 0,
        numberOfIncidentsDurindShift: 0,
        observations: observations || 'Entrada registrada',
        punchInPhoto: punchMeta.photo,
        punchInAddress: punchMeta.address,
        punchInBattery: punchMeta.battery,
        punchInChecklist: checklist
          ? typeof checklist === 'string'
            ? checklist
            : JSON.stringify(checklist)
          : null,
        sessions: appendSession({ sessions: [] }, punchMeta),
        stationNameId: stationId,
        guardNameId: securityGuard.id,
        postSiteId: station.postSiteId || null,
        tenantId,
        createdById: userId,
        updatedById: userId,
      });
    }

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: true });

    // Use the clock-in selfie as the guard's profile picture — best-effort, so a
    // failure never blocks the clock-in. Persisted as the user avatar, so it
    // shows in the CRM and the app profile.
    if (selfiePhoto && typeof selfiePhoto === 'string') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const FileRepository = require('../../database/repositories/fileRepository').default;
        await FileRepository.replaceRelationFiles(
          { belongsTo: 'user', belongsToColumn: 'avatars', belongsToId: userId },
          [{ new: true, name: 'clock-in-selfie.jpg', sizeInBytes: 0, privateUrl: selfiePhoto, publicUrl: null }],
          { database: db, currentUser: req.currentUser, currentTenant: { id: tenantId } } as any,
        );
      } catch (e) {
        console.warn('[clockIn] set avatar from selfie failed:', (e as any)?.message || e);
      }
    }

    // Nómina: evaluate attendance ONLY on the first clock-in of the record
    // (status/late are based on first arrival). Re-clock-ins just reopen the
    // session. Best-effort — never blocks the clock-in.
    if (!isReentry) {
      try {
        await applyClockIn(db, {
          record: guardShiftRecord,
          station,
          securityGuard,
          guardUserId: userId,
          tenantId,
          userId,
          latitude,
          longitude,
          deviceInfo: {
            userAgent: req.headers?.['user-agent'] || null,
            platform: (req.body?.data || req.body)?.platform || null,
          },
          ip: clientIp(req),
          settings: gate.settings,
          geofence: gate.geofence,
          sched: match, // reuse the match from above — no second 12h shift scan
        });
      } catch (attErr) {
        console.error('[clockIn] attendance evaluation failed:', (attErr as any)?.message || attErr);
      }
    }

    // Notify the platform (websocket + in-app) and email the client/tenant/
    // supervisors that the guard started the shift, passing along any open
    // incidents and pending updates. Best-effort: never block the clock-in.
    try {
      const { data, extraEmails } = await gatherClockInContext(db, {
        tenantId,
        station,
        securityGuard,
        observations: guardShiftRecord.observations,
        clockInTime: guardShiftRecord.punchInTime,
        tenant, // reuse the tenant already loaded above (tz + email)
      });
      // Carry THIS punch's selfie + ids in the event payload so the panel
      // notification and the Actividad feed can show the photo and link back.
      (data as any).photoUrl = punchMeta.photo || guardShiftRecord.punchInPhoto || null;
      (data as any).guardId = securityGuard.id;
      (data as any).guardShiftId = guardShiftRecord.id;
      (data as any).stationId = stationId;
      await dispatch('guard.checkin', data, {
        database: db,
        tenantId,
        sourceEntityType: 'guardShift',
        sourceEntityId: guardShiftRecord.id,
        extraEmails,
      });
    } catch (notifyErr) {
      console.error('[clockIn] notification dispatch failed:', (notifyErr as any)?.message || notifyErr);
    }

    return ApiResponseHandler.success(req, res, {
      success: true,
      clockIn: guardShiftRecord.get({ plain: true }),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
