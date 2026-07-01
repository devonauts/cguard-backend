/**
 * POST /api/tenant/:tenantId/guard/me/clock-out
 * 
 * Guard clocks out. Optionally validates GPS.
 * Body: { latitude?, longitude?, observations? }
 */
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import Error401 from '../../errors/Error401';
import {
  applyClockOut,
  closeSession,
  getNominaSettings,
} from '../../services/attendanceService';
import { evaluateGeofence } from '../../lib/geofence';
import { gatherClockOutContext } from '../../lib/clockInContext';
import { dispatch } from '../../lib/notificationDispatcher';

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

    const { latitude, longitude, observations } = req.body.data || req.body;

    // Find securityGuard record
    const securityGuard = await db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });

    if (!securityGuard) {
      throw new Error400(req.language, 'guard.profileNotFound');
    }

    // Find active clock-in
    const activeClock = await db.guardShift.findOne({
      where: { guardNameId: securityGuard.id, punchOutTime: null, tenantId },
      order: [['punchInTime', 'DESC']],
    });

    if (!activeClock) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'not_clocked_in',
        message: 'No tienes un registro de entrada activo.',
      });
    }

    const now = new Date();
    const station = await db.station.findOne({
      where: { id: activeClock.stationNameId, tenantId },
    });

    // ── Early clock-out gate ────────────────────────────────────────────────
    // Leaving more than the configured threshold before the scheduled end needs
    // a supervisor-approved clockOutRequest first. On-time / late / no-schedule
    // clock-outs are immediate.
    const settings = await getNominaSettings(db, tenantId);
    const thresholdMin = Number(settings?.windows?.earlyClockoutThresholdMin ?? 0);
    // Scheduled end comes from the TURNO (single source of truth): prefer the
    // value captured at clock-in, else the currently-active scheduled shift for
    // this guard, so the gate holds even when the record didn't capture it.
    let scheduledEnd = activeClock.scheduledEnd ? new Date(activeClock.scheduledEnd) : null;
    if (!scheduledEnd) {
      const activeShift = await db.shift.findOne({
        where: {
          guardId: userId,
          tenantId,
          startTime: { [Op.lte]: now },
          endTime: { [Op.gte]: now },
        },
        attributes: ['endTime'],
        order: [['endTime', 'DESC']],
      });
      if (activeShift && activeShift.endTime) scheduledEnd = new Date(activeShift.endTime);
    }
    const minutesEarly = scheduledEnd
      ? Math.round((scheduledEnd.getTime() - now.getTime()) / 60000)
      : 0;

    if (scheduledEnd && minutesEarly > thresholdMin) {
      const approved = await db.clockOutRequest.findOne({
        where: {
          guardShiftId: activeClock.id,
          status: 'approved',
          tenantId,
          deletedAt: null,
        },
      });
      if (!approved) {
        return ApiResponseHandler.success(req, res, {
          success: false,
          error: 'approval_required',
          requiresApproval: true,
          scheduledEnd: scheduledEnd.toISOString(),
          minutesEarly,
          thresholdMin,
          message: 'Necesitas aprobación del supervisor para salir antes de tiempo.',
        });
      }
      // Consume the approval so it can't be reused on a later re-clock-in.
      try {
        await approved.update({ status: 'cancelled', updatedById: userId });
      } catch {
        /* ignore */
      }
    }

    // Close the open session + stamp the top-level punch-out (last out).
    const distanceM = station
      ? evaluateGeofence(
          station,
          latitude != null ? Number(latitude) : null,
          longitude != null ? Number(longitude) : null,
          Number(settings?.geofence?.defaultRadiusM) || 100,
        ).distanceM
      : null;

    await activeClock.update({
      punchOutTime: now,
      punchOutLatitude: latitude != null ? Number(latitude) : null,
      punchOutLongitude: longitude != null ? Number(longitude) : null,
      observations: observations || activeClock.observations,
      sessions: closeSession(activeClock, {
        at: now,
        lat: latitude != null ? Number(latitude) : null,
        lng: longitude != null ? Number(longitude) : null,
        distanceM,
      }),
      updatedById: userId,
    });

    // Update isOnDuty
    await securityGuard.update({ isOnDuty: false });

    // Pase de turno (passdown): persist the outgoing guard's handover for this post and
    // turn each instruction into an approved task for the next guard. Always recorded on
    // clock-out (even "Sin novedad") so the relief has continuity + the CRM sees it.
    // `observations` (the end-of-shift report) is the general novedades. Best-effort —
    // never blocks clock-out.
    try {
      const { createPassdown } = require('../../services/shiftPassdownService');
      const body = req.body.data || req.body || {};
      const pd = body.passdown || {};
      if (station) {
        await createPassdown(db, tenantId, {
          station: { id: activeClock.stationNameId, stationName: station.stationName || station.nickname, postSiteId: station.postSiteId },
          guardShift: activeClock,
          outgoingUserId: userId,
          outgoingSecurityGuardId: securityGuard.id,
          outgoingGuardName: securityGuard.fullName || null,
          shiftSchedule: activeClock.shiftSchedule || null,
          notes: observations || activeClock.observations || null,
          instructions: Array.isArray(pd.instructions) ? pd.instructions : [],
          photos: Array.isArray(pd.photos) ? pd.photos : [],
          currentUser,
        });
      }
    } catch (pdErr) {
      console.warn('[clockOut] passdown failed:', (pdErr as any)?.message || pdErr);
    }

    // Nómina: compute hours worked (sum of sessions) + overtime/early-departure,
    // geofence distance, persist exceptions + notify. Best-effort.
    try {
      await applyClockOut(db, {
        record: activeClock,
        station,
        securityGuard,
        tenantId,
        userId,
        latitude,
        longitude,
        ip: clientIp(req),
        settings,
      });
    } catch (attErr) {
      console.error('[clockOut] attendance evaluation failed:', (attErr as any)?.message || attErr);
    }

    // Notify the platform (websocket + in-app CRM event) and email the client/
    // tenant that the guard finished the shift — mirrors the clock-in dispatch.
    // The `guard.checkout` row defaults its email channel ON (notificationChannels),
    // so the tenant is emailed unless they turned it off. Best-effort: never block
    // the clock-out.
    try {
      const { data, extraEmails } = await gatherClockOutContext(db, {
        tenantId,
        station,
        securityGuard,
        observations: activeClock.observations,
        clockOutTime: now,
      });
      (data as any).guardId = securityGuard.id;
      (data as any).guardShiftId = activeClock.id;
      (data as any).stationId = activeClock.stationNameId;
      await dispatch('guard.checkout', data, {
        database: db,
        tenantId,
        sourceEntityType: 'guardShift',
        sourceEntityId: activeClock.id,
        extraEmails,
      });
    } catch (notifyErr) {
      console.error('[clockOut] notification dispatch failed:', (notifyErr as any)?.message || notifyErr);
    }

    // Notify the owning client that a guard ended a shift at their site.
    try {
      const { notifyClient } = require('../../services/clientNotifyService');
      const stationName = (station && (station.stationName || station.nickname)) || 'el puesto';
      await notifyClient(db, tenantId, { stationId: activeClock.stationNameId, postSiteId: station && station.postSiteId }, {
        eventType: 'guard.checkout',
        title: 'Fin de turno',
        body: `${securityGuard.fullName || 'Un guardia'} finalizó turno en ${stationName}.`,
        data: { stationId: String(activeClock.stationNameId || ''), guardId: String(securityGuard.id || ''), guardShiftId: String(activeClock.id || '') },
        sourceEntityType: 'guardShift',
        sourceEntityId: String(activeClock.id),
      });
    } catch (e) { console.warn('[clockOut] client notify failed:', (e as any)?.message || e); }

    // Coverage-change bridge → the customer app. Fires a `coverage`-typed push
    // ("Guardia salió de {puesto}", data { type:'coverage', event:'left' }) to the
    // station's owning customer, alongside the shift-end notify above. Best-effort,
    // fire-and-forget — wrapped so it NEVER affects the punch flow.
    (async () => {
      try {
        const { notifyClientCoverage } = require('../../services/clientNotifyService');
        await notifyClientCoverage(
          db, tenantId, activeClock.stationNameId, securityGuard.id, 'left',
          { stationName: station && (station.stationName || station.nickname), postSiteId: station && station.postSiteId },
        );
      } catch (e) { console.warn('[clockOut] coverage notify failed:', (e as any)?.message || e); }
    })();

    return ApiResponseHandler.success(req, res, {
      success: true,
      clockOut: activeClock.get({ plain: true }),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
