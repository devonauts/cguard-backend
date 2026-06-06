/**
 * One-time backfill: convert legacy shift times from "wall-clock stored as UTC"
 * to TRUE UTC, using each tenant's timezone as the source of truth.
 *
 * Legacy bug: a 7am Ecuador shift was stored as 07:00Z (should be 12:00Z).
 * The guard's phone rendered 07:00Z in local time → 02:00. After this fix the
 * value is the real instant, and display formats it back into the tenant tz.
 *
 * Idempotent via the `tzFixed` flag (added here, default 0 for existing rows;
 * new rows are created with tzFixed=1 so they're never shifted). Tenants in UTC
 * are unaffected (offset 0).
 *
 * Run: npx ts-node scripts/20260605-fix-shift-timezones.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';
import { tzOffsetMinutes } from '../src/lib/tenantTime';

async function migrate() {
  const db: any = models();
  const sequelize = db.sequelize;
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = (await qi.showAllTables()) as string[];
  const table = tables.find((t) => /^shifts?$/i.test(t)) || 'shifts';

  // 1) Add the idempotency flag (existing rows default to 0 = needs fixing).
  const desc = await qi.describeTable(table);
  if (!desc['tzFixed']) {
    await qi.addColumn(table, 'tzFixed', {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
    });
    console.log(`Added tzFixed to ${table}`);
  } else {
    console.log('tzFixed already exists');
  }

  // 2) Per tenant, shift legacy rows by the tenant's UTC offset.
  const tenants = await db.tenant.findAll({ attributes: ['id', 'name', 'timezone'] });
  for (const t of tenants) {
    const tz = t.timezone || 'UTC';
    const offset = tzOffsetMinutes(tz, new Date()); // America/Guayaquil → -300
    const shiftMinutes = -offset;                   // +300 (add 5h)
    const [result]: any = await sequelize.query(
      `UPDATE ${table}
         SET startTime = DATE_ADD(startTime, INTERVAL :m MINUTE),
             endTime   = DATE_ADD(endTime,   INTERVAL :m MINUTE),
             tzFixed = 1
       WHERE tenantId = :tid AND tzFixed = 0`,
      { replacements: { m: shiftMinutes, tid: t.id } },
    );
    const affected = (result && (result.affectedRows ?? result.changedRows)) ?? '?';
    console.log(`  ${t.name}: tz=${tz} shift=${shiftMinutes}min, rows=${affected}`);
  }

  console.log('✅ shift timezone backfill complete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
