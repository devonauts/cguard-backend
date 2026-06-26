/**
 * Guard device management — "bind + flag" policy.
 *
 * The first device a guard reports becomes their BOUND device. When the same
 * guard later reports a DIFFERENT device, that device is recorded and FLAGGED
 * (anti-buddy-punching) but never blocked. Admins see the flag in the guard's
 * Device tab and can reset the binding (so the next device re-binds).
 *
 * Device identity comes from @capacitor/device getId() (a stable per-install id)
 * plus model / OS / app version. The FCM push token is stored separately.
 */
import { dispatch } from '../lib/notificationDispatcher';

export interface DeviceInput {
  deviceId: string;
  platform?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
  pushToken?: string | null;
}

export interface RegisterResult {
  record: any;
  bound: boolean; // this device is the guard's bound device
  mismatch: boolean; // reported a device other than the bound one
}

/**
 * Upsert the guard's device and apply the bind/flag policy.
 * Safe to call on login, app resume, and clock-in.
 */
export async function registerGuardDevice(
  db: any,
  tenantId: string,
  userId: string,
  input: DeviceInput,
): Promise<RegisterResult> {
  const deviceId = String(input.deviceId || '').trim();
  if (!deviceId) throw Object.assign(new Error('deviceId required'), { code: 400 });

  const now = new Date();
  const meta = {
    platform: input.platform ?? null,
    model: input.model ?? null,
    manufacturer: input.manufacturer ?? null,
    osVersion: input.osVersion ?? null,
    appVersion: input.appVersion ?? null,
  };

  // Upsert this device for this guard (keyed by deviceId + tenant).
  let record = await db.deviceIdInformation.findOne({
    where: { deviceId, tenantId },
  });
  if (record) {
    await record.update({
      userId,
      ...meta,
      ...(input.pushToken ? { pushToken: String(input.pushToken) } : {}),
      lastSeenAt: now,
      updatedById: userId,
    });
  } else {
    record = await db.deviceIdInformation.create({
      deviceId,
      tenantId,
      userId,
      ...meta,
      pushToken: input.pushToken ? String(input.pushToken) : null,
      lastSeenAt: now,
      createdById: userId,
      updatedById: userId,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logSecurityEvent } = require('./auth/securityAudit');
      await logSecurityEvent(db, { tenantId, userId, event: 'device_registered', deviceId, platform: meta.platform, detail: meta.model || null });
    } catch { /* ignore */ }
  }

  // Binding: first device binds; a different device is flagged.
  const bound = await db.deviceIdInformation.findOne({
    where: { tenantId, userId, isBound: true },
  });

  let isBound = false;
  let mismatch = false;
  // Only the FIRST report that flags a device alerts supervisors. registerGuardDevice
  // runs on every login / app resume / clock-in, so without this a guard on a
  // non-bound device would re-notify on every app open.
  let newlyFlagged = false;

  if (!bound) {
    // First device for this guard → bind it.
    await record.update({ isBound: true, flagged: false });
    isBound = true;
  } else if (bound.deviceId === deviceId) {
    // Reporting their own bound device → clear any stale flag.
    if (record.flagged) await record.update({ flagged: false });
    isBound = true;
  } else {
    // A device other than the bound one → flag it. Notify only on the transition
    // into the flagged state; later reports just refresh lastMismatchAt. The flag
    // persists until an admin resets the binding, which re-arms the alert.
    newlyFlagged = !record.flagged;
    await record.update({ flagged: true, lastMismatchAt: now });
    mismatch = true;
  }

  if (mismatch && newlyFlagged) {
    // Best-effort alert to supervisors; never break registration.
    try {
      const guard = await db.user.findByPk(userId, { attributes: ['fullName'] });
      await dispatch(
        'device.mismatch',
        {
          guardName: guard?.fullName || 'Guardia',
          model: meta.model || meta.platform || 'dispositivo desconocido',
          deviceId,
        },
        {
          database: db,
          tenantId,
          sourceEntityType: 'deviceIdInformation',
          sourceEntityId: record.id,
        },
      );
    } catch (e) {
      console.warn('[guardDeviceService] mismatch dispatch failed:', (e as any)?.message || e);
    }
  }

  // Trusted-device cap: keep at most 10 devices per guard; evict the oldest
  // (never the bound one). Logs each eviction.
  try {
    const all = await db.deviceIdInformation.findAll({
      where: { tenantId, userId },
      order: [['lastSeenAt', 'DESC'], ['createdAt', 'DESC']],
    });
    if (all.length > 10) {
      for (const d of all.slice(10)) {
        if (d.isBound) continue;
        await d.destroy();
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { logSecurityEvent } = require('./auth/securityAudit');
          await logSecurityEvent(db, { tenantId, userId, event: 'device_evicted', deviceId: d.deviceId, platform: d.platform, detail: 'Límite de 10 dispositivos confiables alcanzado.' });
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    console.warn('[guardDeviceService] device cap failed:', (e as any)?.message || e);
  }

  return { record, bound: isBound, mismatch };
}

/**
 * Admin "reset binding": unbind all of the guard's devices and clear flags, so
 * the next device the guard reports becomes the new bound device. `userId` is
 * resolved from the given device record.
 */
export async function resetGuardBinding(
  db: any,
  tenantId: string,
  deviceRecordId: string,
  actorUserId: string,
): Promise<{ userId: string | null; cleared: number }> {
  const device = await db.deviceIdInformation.findOne({
    where: { id: deviceRecordId, tenantId },
  });
  if (!device || !device.userId) return { userId: null, cleared: 0 };

  const [cleared] = await db.deviceIdInformation.update(
    { isBound: false, flagged: false, updatedById: actorUserId },
    { where: { tenantId, userId: device.userId } },
  );
  return { userId: device.userId, cleared: cleared || 0 };
}
