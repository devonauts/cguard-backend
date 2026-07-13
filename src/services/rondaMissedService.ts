/**
 * Missed/overdue ronda sweep (Configuración › Rondas › "Notificar rondas
 * perdidas/tarde"). The cadence knobs (frequencyMinutes, graceMinutes,
 * maxDurationMinutes) were stored but nothing consumed them — this closes
 * the loop. Leader-elected caller (server.ts), every 5 minutes.
 *
 * Two detections, both deduped via tourAssignments.missedNotifiedAt:
 *  A) STARTED but not completed within maxDurationMinutes + graceMinutes
 *     ("ronda incompleta") — re-alertable only if the round was re-started
 *     after the last alert. Only looks at rounds started in the last 48h so
 *     the first deploy doesn't flood ops with ancient stale assignments.
 *  B) NEVER started while the assigned guard is ON DUTY and their shift began
 *     more than frequencyMinutes + graceMinutes ago ("ronda no realizada") —
 *     re-alertable once per shift (missedNotifiedAt < shift start).
 */
import { Op } from 'sequelize';
import { notifyPatrol, resolveRondaSettings } from './rondaNotify';

export async function runRondaMissedSweep(db: any): Promise<void> {
  if (!db.tourAssignment) return;
  const now = Date.now();

  // Per (tenant, postSite) settings cache for the sweep.
  const settingsCache = new Map<string, any>();
  const settingsFor = async (tenantId: string, postSiteId: string | null) => {
    const key = `${tenantId}|${postSiteId || ''}`;
    if (!settingsCache.has(key)) {
      settingsCache.set(key, await resolveRondaSettings(db, tenantId, postSiteId));
    }
    return settingsCache.get(key);
  };

  const tourCache = new Map<string, any>();
  const tourFor = async (siteTourId: string) => {
    if (!tourCache.has(siteTourId)) {
      tourCache.set(
        siteTourId,
        await db.siteTour.findByPk(siteTourId, { attributes: ['id', 'name', 'postSiteId'] }),
      );
    }
    return tourCache.get(siteTourId);
  };

  const guardName = async (securityGuardId: string | null): Promise<string | undefined> => {
    if (!securityGuardId) return undefined;
    try {
      const sg = await db.securityGuard.findByPk(securityGuardId, { attributes: ['fullName'] });
      return sg?.fullName || undefined;
    } catch {
      return undefined;
    }
  };

  // ── Leg A: started but overdue ─────────────────────────────────────────────
  const started = await db.tourAssignment.findAll({
    where: {
      status: 'assigned',
      startAt: {
        [Op.ne]: null,
        [Op.gt]: new Date(now - 48 * 3600 * 1000),
      },
    },
    limit: 1000,
  });
  for (const a of started) {
    try {
      const tour = await tourFor(a.siteTourId);
      if (!tour) continue;
      const s = await settingsFor(String(a.tenantId), tour.postSiteId || null);
      if (s.active === false || !s.notifyTenantOnMissed) continue;

      const allowedMs = ((Number(s.maxDurationMinutes) || 60) + (Number(s.graceMinutes) || 0)) * 60_000;
      if (now - new Date(a.startAt).getTime() < allowedMs) continue;
      if (a.missedNotifiedAt && new Date(a.missedNotifiedAt) >= new Date(a.startAt)) continue;

      // Progress snapshot for the alert body.
      let detail: string | undefined;
      try {
        const [total, scanned] = await Promise.all([
          db.siteTourTag.count({ where: { siteTourId: a.siteTourId } }),
          db.tagScan.count({ where: { tourAssignmentId: a.id }, distinct: true, col: 'siteTourTagId' }),
        ]);
        if (total > 0) detail = `incompleta: ${scanned} de ${total} puntos`;
      } catch { /* detail is optional */ }

      await a.update({ missedNotifiedAt: new Date() });
      await notifyPatrol(db, {
        tenantId: String(a.tenantId),
        postSiteId: tour.postSiteId,
        event: 'missed',
        routeName: tour.name,
        guardName: await guardName(a.securityGuardId),
        settings: s,
        detail,
      });
    } catch (err) {
      console.warn('[rondaMissed] leg A failed:', (err as any)?.message || err);
    }
  }

  // ── Leg B: never started while the guard is on duty ───────────────────────
  const unstarted = await db.tourAssignment.findAll({
    where: { status: 'assigned', startAt: null, securityGuardId: { [Op.ne]: null } },
    limit: 1000,
  });
  for (const a of unstarted) {
    try {
      const shift = await db.guardShift.findOne({
        where: { tenantId: a.tenantId, guardNameId: a.securityGuardId, punchOutTime: null },
        attributes: ['id', 'punchInTime'],
      });
      if (!shift?.punchInTime) continue;

      const tour = await tourFor(a.siteTourId);
      if (!tour) continue;
      const s = await settingsFor(String(a.tenantId), tour.postSiteId || null);
      if (s.active === false || !s.notifyTenantOnMissed) continue;

      const dueMs = ((Number(s.frequencyMinutes) || 60) + (Number(s.graceMinutes) || 0)) * 60_000;
      if (now - new Date(shift.punchInTime).getTime() < dueMs) continue;
      // Once per shift: re-alert only if the last alert predates this shift.
      if (a.missedNotifiedAt && new Date(a.missedNotifiedAt) >= new Date(shift.punchInTime)) continue;

      await a.update({ missedNotifiedAt: new Date() });
      await notifyPatrol(db, {
        tenantId: String(a.tenantId),
        postSiteId: tour.postSiteId,
        event: 'missed',
        routeName: tour.name,
        guardName: await guardName(a.securityGuardId),
        settings: s,
        detail: 'no se ha realizado en el turno actual',
      });
    } catch (err) {
      console.warn('[rondaMissed] leg B failed:', (err as any)?.message || err);
    }
  }
}

export default { runRondaMissedSweep };
