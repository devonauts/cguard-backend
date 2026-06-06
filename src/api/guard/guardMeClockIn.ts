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
import { clockGate, applyClockIn } from '../../services/attendanceService';

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
      selfiePhoto, address, battery, checklist } = req.body.data || req.body;

    // TESTING ESCAPE HATCH: GUARD_GEOFENCE_BYPASS=true lets a guard clock in
    // from anywhere — and without a GPS fix at all. Off (default) → enforced.
    const geofenceBypass = ['1', 'true', 'yes', 'on'].includes(
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

    // Validate the guard is assigned to this station via the SINGLE SOURCE OF
    // TRUTH: an active guardAssignment, or a generated shift covering today.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

    const hasAssignment = await db.guardAssignment.findOne({
      where: { guardId: userId, stationId, tenantId, status: 'active', deletedAt: null },
      attributes: ['id'],
    });
    let isAssigned = !!hasAssignment;
    if (!isAssigned) {
      const shiftToday = await db.shift.findOne({
        where: {
          guardId: userId, stationId, tenantId,
          startTime: { [Op.lte]: endOfDay },
          endTime: { [Op.gte]: startOfDay },
        },
        attributes: ['id'],
      });
      isAssigned = !!shiftToday;
    }
    if (!isAssigned) {
      throw new Error400(req.language, 'guard.notAssignedToStation');
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

    // Check if already clocked in
    const existingClock = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, punchOutTime: null, tenantId },
    });

    if (existingClock) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'already_clocked_in',
        message: 'Ya tienes un registro de entrada activo.',
        activeClockIn: existingClock.get({ plain: true }),
      });
    }

    // Create guardShift (clock-in record)
    const guardShiftRecord = await db.guardShift.create({
      punchInTime: new Date(),
      punchInLatitude: latitude != null ? Number(latitude) : null,
      punchInLongitude: longitude != null ? Number(longitude) : null,
      shiftSchedule: shiftSchedule || 'Diurno',
      numberOfPatrolsDuringShift: 0,
      numberOfIncidentsDurindShift: 0,
      observations: observations || 'Entrada registrada',
      punchInPhoto: selfiePhoto || null,
      punchInAddress: address ? String(address).slice(0, 512) : null,
      punchInBattery: battery != null && !isNaN(Number(battery)) ? Math.round(Number(battery)) : null,
      punchInChecklist: checklist
        ? (typeof checklist === 'string' ? checklist : JSON.stringify(checklist))
        : null,
      stationNameId: stationId,
      guardNameId: securityGuard.id,
      postSiteId: station.postSiteId || null,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: true });

    // Nómina: evaluate attendance (match scheduled shift, status, geofence
    // distance, late/pending-review), persist exceptions + notify supervisors.
    // Best-effort — never blocks the clock-in.
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
      });
    } catch (attErr) {
      console.error('[clockIn] attendance evaluation failed:', (attErr as any)?.message || attErr);
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
      });
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
