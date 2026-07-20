/**
 * Forced clock-out at shift end.
 *
 * A guard who finishes their shift but never clocks out in the app leaves an
 * open guardShift forever (isOnDuty stuck on). This scheduler scans for active
 * shifts whose scheduled end passed more than GRACE minutes ago and force-closes
 * them, flagging `forcedClockOut` (= no manual close, no end-of-shift novedades).
 * That flag drives a light performance penalty (guardPerformanceService) and a
 * notification to the guard (FCM → worker app redirects to dashboard) and to the
 * tenant's admins/supervisors (in-app CRM event).
 *
 * Cluster-safe: the work is claimed per-row with an atomic conditional UPDATE on
 * `punchOutTime IS NULL`, so exactly one PM2 worker closes each shift.
 */
import { Op } from 'sequelize';
import { applyClockOut, closeSession, getNominaSettings } from './attendanceService';
import { pushToUser } from './pushService';
import { storePlatformEvent } from '../lib/platformEventStore';

const GRACE_MIN = parseInt(process.env.FORCED_CLOCKOUT_GRACE_MIN || '15', 10);
// Backstop for punches with no scheduledEnd (see the candidates query).
const MAX_OPEN_HOURS = parseInt(process.env.FORCED_CLOCKOUT_MAX_OPEN_HOURS || '30', 10);
const FORCED_NOTE =
  'Salida forzada automática: el turno terminó y el guardia no cerró el turno ni reportó novedades en la app.';
// guardShift.observations is TEXT with validate.len [0, 500]. Appending the note
// to an already-long observation blew past 500, the update threw, and the
// sweeper retried the SAME row every minute forever — so that shift never
// closed and the guard stayed "presente" indefinitely. Truncate instead.
const OBS_MAX = 500;
const appendNote = (existing: any): string => {
  const base = (existing == null ? '' : String(existing)).trim();
  const joined = base ? `${base} — ${FORCED_NOTE}` : FORCED_NOTE;
  if (joined.length <= OBS_MAX) return joined;
  // Keep the note (it explains the forced close) and trim the older text.
  const room = OBS_MAX - FORCED_NOTE.length - 4; // 4 = ' — ' + ellipsis
  return room > 0 ? `${base.slice(0, room)}… — ${FORCED_NOTE}` : FORCED_NOTE.slice(0, OBS_MAX);
};

export async function runForcedShiftEndClockOut(db: any) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - GRACE_MIN * 60000);

  // Active shifts (still clocked in) whose scheduled end passed more than the
  // grace window ago. Forced shifts already have punchOutTime, so they're excluded.
  //
  // The scheduledEnd branch alone left a hole: a punch created WITHOUT a
  // scheduledEnd (ad-hoc clock-in, demo/seeded data, a turno deleted after the
  // guard punched in) never matched, so it stayed open forever and kept showing
  // the guard as "presente" in client coverage for days. The second branch is
  // the backstop — no turno lasts longer than MAX_OPEN_HOURS, so anything older
  // is abandoned regardless of what it was scheduled to do.
  const hardCutoff = new Date(now.getTime() - MAX_OPEN_HOURS * 3600000);
  const candidates = await db.guardShift.findAll({
    where: {
      punchOutTime: null,
      deletedAt: null,
      [Op.or]: [
        { scheduledEnd: { [Op.ne]: null, [Op.lte]: cutoff } },
        { scheduledEnd: null, punchInTime: { [Op.lte]: hardCutoff } },
      ],
    },
    limit: 200,
  });

  for (const candidate of candidates) {
    const shiftId = candidate.id;
    const tenantId = candidate.tenantId;
    try {
      // Cluster-safe claim: only the worker that flips punchOutTime proceeds.
      const note = appendNote(candidate.observations);
      const [claimed] = await db.guardShift.update(
        { punchOutTime: now, forcedClockOut: true, observations: note },
        { where: { id: shiftId, punchOutTime: null } },
      );
      if (!claimed) continue;

      const fresh = await db.guardShift.findByPk(shiftId);
      if (!fresh) continue;
      const securityGuard = await db.securityGuard.findByPk(fresh.guardNameId);
      const station = fresh.stationNameId ? await db.station.findByPk(fresh.stationNameId) : null;

      // Close the open session JSON and flip isOnDuty off.
      try {
        await fresh.update({ sessions: closeSession(fresh, { at: now, lat: null, lng: null, distanceM: null }) });
      } catch (e) { /* non-fatal */ }
      if (securityGuard) {
        try { await securityGuard.update({ isOnDuty: false }); } catch (e) { /* non-fatal */ }
      }

      // Hours/status/exceptions via the normal attendance pipeline (best-effort).
      try {
        const settings = await getNominaSettings(db, tenantId);
        await applyClockOut(db, {
          record: fresh, station, securityGuard, tenantId,
          userId: securityGuard?.guardId, latitude: null, longitude: null, ip: null, settings,
        });
      } catch (e) {
        console.error('[forcedClockOut] applyClockOut failed:', (e as any)?.message || e);
      }

      const guardName = securityGuard?.fullName || 'Guardia';
      const stationName = station?.stationName || '';

      // Notify the guard (FCM) → the worker app drops them to the dashboard.
      if (securityGuard?.guardId) {
        try {
          await pushToUser(db, tenantId, securityGuard.guardId, {
            title: 'Turno finalizado',
            body: 'Tu turno terminó y se registró tu salida automáticamente.',
            data: { type: 'guard.forced_clockout', guardShiftId: String(fresh.id) },
          });
        } catch (e) { /* non-fatal */ }
      }

      // Notify admins + supervisors (in-app CRM event, SSE-polled).
      try {
        await storePlatformEvent(db, {
          tenantId,
          eventType: 'guard.forced_clockout',
          title: 'Salida forzada por fin de turno',
          body: `${guardName}${stationName ? ' · ' + stationName : ''} no cerró su turno; se registró salida automática (sin reporte de novedades).`,
          payload: { guardShiftId: fresh.id, guardId: fresh.guardNameId, stationId: fresh.stationNameId },
          targetRoles: 'admin,securitySupervisor,operationsManager',
          sourceEntityType: 'guardShift',
          sourceEntityId: fresh.id,
        });
      } catch (e) { /* non-fatal */ }

      console.log(`[forcedClockOut] ${guardName} forced out (shift ${shiftId})`);
    } catch (err) {
      console.error('[forcedClockOut] failed for shift', shiftId, (err as any)?.message || err);
    }
  }
}
