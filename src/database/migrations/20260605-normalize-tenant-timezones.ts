/**
 * Normalize existing tenant.timezone values: any non-IANA value (e.g. "GMT-5",
 * a display name, blank) is reset to 'UTC'. New writes are blocked by the
 * model's isValidTimezone validator; this cleans up rows saved before it.
 * Idempotent — re-running only touches still-invalid rows.
 *
 * Run: npx ts-node src/database/migrations/20260605-normalize-tenant-timezones.ts
 */
require('dotenv').config();

import models from '../models';

function isValidTimeZone(tz: any): boolean {
  if (!tz || typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

async function migrate() {
  const db = models();

  const tenants = await db.tenant.findAll({ attributes: ['id', 'timezone'] });
  let fixed = 0;
  for (const tnt of tenants) {
    if (!isValidTimeZone(tnt.timezone)) {
      console.log(
        `tenant ${tnt.id}: invalid timezone ${JSON.stringify(tnt.timezone)} → UTC`,
      );
      // Skip validation/hooks: we're writing the known-good fallback and don't
      // want unrelated field validators to block the cleanup.
      await db.tenant.update(
        { timezone: 'UTC' },
        { where: { id: tnt.id }, validate: false, hooks: false },
      );
      fixed++;
    }
  }

  console.log(`✅ normalized ${fixed} invalid tenant timezone(s) of ${tenants.length}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
