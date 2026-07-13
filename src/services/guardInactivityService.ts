/**
 * Guard inactivity sweep (Configuración Global de Vigilantes › alerta de
 * inactividad). Every tick, finds ON-DUTY guards whose device has gone silent
 * (no GPS ping) for longer than the tenant's threshold and alerts supervisors
 * via the guard.inactive event ("inactive-guard-alert" channel row).
 *
 * One alert per silence EPISODE: guardShifts.inactivityAlertAt records the
 * last alert; a new alert only fires when activity resumed after it (lastSeen
 * moved past the stamp) and then went silent again. Guards whose app never
 * pings alert once per shift (baseline = punchInTime) — that's deliberate:
 * "no signal at all" is exactly what the rule watches for.
 *
 * Leader-elected caller (server.ts); runs across all tenants in one pass.
 */
import { Op } from 'sequelize';
import { getGuardSettings } from './guardSettingsService';
import { dispatch } from '../lib/notificationDispatcher';

export async function runGuardInactivitySweep(db: any): Promise<void> {
  const now = Date.now();

  const shifts = await db.guardShift.findAll({
    where: { punchOutTime: null, punchInTime: { [Op.ne]: null } },
    attributes: [
      'id', 'tenantId', 'guardNameId', 'postSiteId', 'stationNameId',
      'punchInTime', 'liveLocationAt', 'inactivityAlertAt',
    ],
    limit: 2000,
  });
  if (!shifts.length) return;

  // Per-tenant settings, read once per tenant per sweep.
  const settingsByTenant = new Map<string, any>();
  const settingsFor = async (tenantId: string) => {
    if (!settingsByTenant.has(tenantId)) {
      settingsByTenant.set(tenantId, await getGuardSettings(db, tenantId));
    }
    return settingsByTenant.get(tenantId);
  };

  for (const shift of shifts) {
    try {
      const s = await settingsFor(String(shift.tenantId));
      if (!s.inactivityAlert) continue;

      const lastSeen = shift.liveLocationAt || shift.punchInTime;
      if (!lastSeen) continue;
      const silentMs = now - new Date(lastSeen).getTime();
      if (silentMs < s.inactivityThresholdMin * 60_000) continue;

      // Already alerted for this silence episode?
      if (
        shift.inactivityAlertAt &&
        new Date(shift.inactivityAlertAt).getTime() >= new Date(lastSeen).getTime()
      ) {
        continue;
      }

      await shift.update({ inactivityAlertAt: new Date() });

      const [guard, station] = await Promise.all([
        db.securityGuard.findByPk(shift.guardNameId, { attributes: ['fullName'] }),
        shift.stationNameId
          ? db.station.findByPk(shift.stationNameId, { attributes: ['stationName'] })
          : Promise.resolve(null),
      ]);

      dispatch('guard.inactive', {
        guardName: guard?.fullName || 'Vigilante',
        stationName: station?.stationName || null,
        silentMinutes: Math.floor(silentMs / 60_000),
      }, {
        database: db,
        tenantId: String(shift.tenantId),
        sourceEntityType: 'guardShift',
        sourceEntityId: shift.id,
        assignedPostSiteId: shift.postSiteId || undefined,
      }).catch(() => {});
    } catch (err) {
      console.warn('[guardInactivity] shift sweep failed:', (err as any)?.message || err);
    }
  }
}

export default { runGuardInactivitySweep };
