/**
 * License/credential expiry sweep (Configuración Global de Vigilantes ›
 * expiración de credenciales). Daily, leader-elected: finds guardLicenses
 * whose expiryDate is within the tenant's alert window (or already past) and
 * notifies HR via guard.license_expiring ("license-expiry" channel row).
 *
 * Re-alert cadence: at most once per license per 7 days, deduped against the
 * platformEvents table (raw SQL — it's not a Sequelize model), so HR gets a
 * weekly reminder until the credential is renewed or removed.
 */
import { Op } from 'sequelize';
import { getGuardSettings } from './guardSettingsService';
import { dispatch } from '../lib/notificationDispatcher';

const REALERT_DAYS = 7;

export async function runLicenseExpirySweep(db: any): Promise<void> {
  if (!db.guardLicense) return;
  const today = new Date();
  const maxWindow = new Date(today.getTime() + 120 * 24 * 3600 * 1000);

  const licenses = await db.guardLicense.findAll({
    where: { expiryDate: { [Op.ne]: null, [Op.lte]: maxWindow } },
    include: [
      { model: db.securityGuard, as: 'guard', attributes: ['id', 'fullName'] },
      { model: db.licenseType, as: 'licenseType', attributes: ['id', 'name'], required: false },
    ],
    limit: 3000,
  });
  if (!licenses.length) return;

  const settingsByTenant = new Map<string, any>();
  const settingsFor = async (tenantId: string) => {
    if (!settingsByTenant.has(tenantId)) {
      settingsByTenant.set(tenantId, await getGuardSettings(db, tenantId));
    }
    return settingsByTenant.get(tenantId);
  };

  const realertCutoff = new Date(Date.now() - REALERT_DAYS * 24 * 3600 * 1000);

  for (const lic of licenses) {
    try {
      const tenantId = String(lic.tenantId);
      const s = await settingsFor(tenantId);
      if (!s.licenseExpiryAlert) continue;

      const expiry = new Date(lic.expiryDate);
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (24 * 3600 * 1000));
      if (daysLeft > s.licenseExpiryDays) continue;

      // Weekly dedupe against platformEvents (raw table, not a model).
      const [rows]: any = await db.sequelize.query(
        `SELECT id FROM platform_events
          WHERE eventType = 'guard.license_expiring'
            AND sourceEntityId = :licId
            AND createdAt >= :cutoff
          LIMIT 1`,
        { replacements: { licId: String(lic.id), cutoff: realertCutoff } },
      );
      if (Array.isArray(rows) && rows.length) continue;

      dispatch('guard.license_expiring', {
        guardName: lic.guard?.fullName || 'Vigilante',
        licenseName: lic.licenseType?.name || 'Credencial',
        expiryDate: expiry.toISOString().slice(0, 10),
        daysLeft,
      }, {
        database: db,
        tenantId,
        sourceEntityType: 'guardLicense',
        sourceEntityId: String(lic.id),
      }).catch(() => {});
    } catch (err) {
      console.warn('[licenseExpiry] sweep item failed:', (err as any)?.message || err);
    }
  }
}

export default { runLicenseExpirySweep };
