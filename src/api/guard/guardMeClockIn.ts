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
import { timeLabelInTz } from '../../lib/tenantTime';

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

    // Demo tenant (sales demos + app-store review): reviewers clock in from any
    // country at any hour, so location/geofence, the rest-day gate and the shift
    // window are NOT enforced there. Hard-gated to the configured DEMO_TENANT_ID
    // (see demoConstants) — every other tenant keeps full enforcement.
    const { configuredDemoTenantId } = require('../../services/demo/demoConstants');
    const demoBypass = !!tenantId && tenantId === configuredDemoTenantId();

    // Geofence enforcement is ON in production: location is required and the
    // distance is validated against the station radius. The only escape hatch is
    // the GUARD_GEOFENCE_BYPASS env var (off by default). To clock in from far
    // away without bypassing, set a large station/tenant geofence radius instead.
    const TESTING_FORCE_BYPASS = false;
    const geofenceBypass =
      TESTING_FORCE_BYPASS ||
      demoBypass ||
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
    if (!shiftToday && !demoBypass) {
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

    // ── Clock-in WINDOW gate ─────────────────────────────────────────────────
    // Only allow the punch within a window around the scheduled shift start:
    //   [scheduledStart - effectiveEarly , scheduledStart + effectiveLate].
    // Too early → soft-block. Late → require an APPROVED clockInRequest for today.
    // Skipped entirely when the scheduled start is unknown (generation lag /
    // unschedulable) so we never wrongly block. Independent of geofence bypass.
    let approvedLateRequest: any = null;
    if (match.scheduledStart && !demoBypass) {
      const effectiveEarly = station.clockInEarlyBufferMin != null
        ? Number(station.clockInEarlyBufferMin)
        : Number(gate.settings.windows.earlyClockInMin);
      const effectiveLate = station.clockInLateGraceMin != null
        ? Number(station.clockInLateGraceMin)
        : Number(gate.settings.windows.lateGraceMin);

      const scheduledStart = new Date(match.scheduledStart);
      const windowOpen = new Date(scheduledStart.getTime() - effectiveEarly * 60000);
      const lateLimit = new Date(scheduledStart.getTime() + effectiveLate * 60000);

      if (now < windowOpen) {
        return ApiResponseHandler.success(req, res, {
          success: false,
          error: 'too_early',
          message: `No puedes marcar entrada todavía. Disponible desde las ${timeLabelInTz(windowOpen, tz)}.`,
          scheduledStart: scheduledStart.toISOString(),
          availableAt: windowOpen.toISOString(),
        });
      }

      if (now > lateLimit) {
        // Late: only allowed with a supervisor-approved request for TODAY.
        // Identity is guard + station + today (NOT shiftId — shift rows get
        // regenerated by the scheduler, so the request's stored shiftId can
        // legitimately differ from the one matched at punch time, which used to
        // wrongly block an approved guard). Reuse is prevented by marking the
        // request 'used' after a successful punch.
        const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
        approvedLateRequest = await db.clockInRequest.findOne({
          where: {
            guardUserId: userId,
            stationId,
            tenantId,
            status: 'approved',
            createdAt: { [Op.gte]: startOfToday },
            // The approval window (set at decision time, e.g. +60min) must not
            // have lapsed — without this check an approval stays valid all day.
            [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gte]: now } }],
            deletedAt: null,
          },
          order: [['createdAt', 'DESC']],
        });

        if (!approvedLateRequest) {
          const lateByMin = Math.round((now.getTime() - scheduledStart.getTime()) / 60000);
          return ApiResponseHandler.success(req, res, {
            success: false,
            error: 'late_needs_approval',
            message: 'Llegada tarde. Necesitas aprobación del supervisor para marcar entrada.',
            scheduledStart: scheduledStart.toISOString(),
            lateByMin,
          });
        }
      }
    }

    // No double-booking: a guard may hold only ONE open clock-in at a time,
    // anywhere. findOpenOrShiftRecord below is scoped to THIS station, so it
    // misses an open session at a DIFFERENT station — which previously let a
    // guard open a second concurrent shift (and clock-out closed only one).
    const openElsewhere = await db.guardShift.findOne({
      where: { tenantId, guardNameId: securityGuard.id, punchOutTime: null },
    });
    if (openElsewhere && String(openElsewhere.stationNameId) !== String(stationId)) {
      return ApiResponseHandler.success(req, res, {
        success: false,
        error: 'already_clocked_in_elsewhere',
        message: 'Ya tienes una entrada activa en otra estación. Marca salida antes de iniciar otra.',
        activeClockIn: openElsewhere.get({ plain: true }),
      });
    }

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

    // Consume the late-approval request that unlocked this punch (best-effort).
    if (approvedLateRequest) {
      try {
        await approvedLateRequest.update({ status: 'used', updatedById: userId });
      } catch (e) {
        console.warn('[clockIn] mark clockInRequest used failed:', (e as any)?.message || e);
      }
    }

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

    // Notify the owning client (Mi Seguridad app) that a guard started a shift at
    // their site. If this clock-in RELIEVES a guard who recently clocked out at the
    // same station (a cambio de turno / relevo), send a richer notification with the
    // guardia ENTRANTE, the guardia SALIENTE and the saliente's novedades (their
    // clock-out handover notes). Otherwise send the plain "Inicio de turno".
    try {
      const { notifyClient } = require('../../services/clientNotifyService');
      const stationName = (station && (station.stationName || station.nickname)) || 'el puesto';
      const guardName = securityGuard.fullName || 'Un guardia';
      const selfieUrl = punchMeta.photo || guardShiftRecord.punchInPhoto || '';
      const baseData: Record<string, string> = {
        stationId: String(stationId || ''),
        stationName,
        guardId: String(securityGuard.id || ''),
        guardName,
        guardShiftId: String(guardShiftRecord.id || ''),
        selfieUrl: String(selfieUrl || ''),
      };

      // Find the SALIENTE: the most recent guard who clocked OUT at this station
      // within the relief window, who isn't this guard.
      const RELIEF_WINDOW_HOURS = 6;
      const reliefSince = new Date(now.getTime() - RELIEF_WINDOW_HOURS * 60 * 60 * 1000);
      // Only a FIRST clock-in can be a relevo — a re-entry (same guard reopening
      // their own session after a break) is never a cambio de turno.
      const outgoing = isReentry ? null : await db.guardShift.findOne({
        where: {
          tenantId,
          stationNameId: stationId,
          guardNameId: { [Op.ne]: securityGuard.id },
          punchOutTime: { [Op.ne]: null, [Op.gte]: reliefSince },
        },
        order: [['punchOutTime', 'DESC']],
        attributes: ['id', 'guardNameId', 'observations', 'punchOutTime'],
      });

      if (outgoing) {
        const outGuard = await db.securityGuard.findByPk(outgoing.guardNameId, { attributes: ['id', 'fullName'] });
        const outName = (outGuard && outGuard.fullName) || 'Guardia saliente';
        // The saliente's clock-out observations ARE the pase de novedades. Treat the
        // system default placeholders as "no news".
        const raw = (outgoing.observations && String(outgoing.observations).trim()) || '';
        const isPlaceholder = !raw || /^(entrada|salida) registrada$/i.test(raw);
        const novedades = isPlaceholder ? '' : raw;
        const novText = novedades ? `Novedades: ${novedades}` : 'Sin novedades.';
        await notifyClient(db, tenantId, { stationId, postSiteId: station && station.postSiteId }, {
          eventType: 'guard.shiftchange',
          title: `Cambio de turno en ${stationName}`,
          body: `Guardia entrante: ${guardName}. Guardia saliente: ${outName}. ${novText}`,
          image: selfieUrl || undefined,
          data: {
            ...baseData,
            incomingGuardId: String(securityGuard.id || ''),
            incomingGuardName: guardName,
            outgoingGuardId: String((outGuard && outGuard.id) || outgoing.guardNameId || ''),
            outgoingGuardName: outName,
            novedades,
          },
          sourceEntityType: 'guardShift',
          sourceEntityId: String(guardShiftRecord.id),
        });
      } else {
        await notifyClient(db, tenantId, { stationId, postSiteId: station && station.postSiteId }, {
          eventType: 'guard.checkin',
          title: 'Inicio de turno',
          body: `${guardName} inició turno en ${stationName}.`,
          image: selfieUrl || undefined,
          data: baseData,
          sourceEntityType: 'guardShift',
          sourceEntityId: String(guardShiftRecord.id),
        });
      }
    } catch (e) { console.warn('[clockIn] client notify failed:', (e as any)?.message || e); }

    // Coverage-change bridge → the customer app. Fires a `coverage`-typed push
    // ("Guardia llegó a {puesto}", data { type:'coverage', event:'arrived' }) to
    // the station's owning customer, alongside the richer shift-start notify above.
    // Best-effort, fire-and-forget — wrapped so it NEVER affects the punch flow.
    (async () => {
      try {
        const { notifyClientCoverage } = require('../../services/clientNotifyService');
        await notifyClientCoverage(
          db, tenantId, stationId, securityGuard.id, 'arrived',
          { stationName: station && (station.stationName || station.nickname), postSiteId: station && station.postSiteId },
        );
      } catch (e) { console.warn('[clockIn] coverage notify failed:', (e as any)?.message || e); }
    })();

    return ApiResponseHandler.success(req, res, {
      success: true,
      clockIn: guardShiftRecord.get({ plain: true }),
    });
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
