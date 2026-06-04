/**
 * Add a unique index on shifts (tenantId, guardId, stationId, startTime, endTime)
 * so the generator can never create duplicate shifts again. Run AFTER de-duplicating
 * existing rows (otherwise the ALTER fails on existing duplicates).
 *
 * Run: npx ts-node scripts/20260603-add-unique-shift-slot-index.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();

  const existing: any[] = await sequelize.query(
    "SHOW INDEX FROM shifts WHERE Key_name = 'uniq_shift_slot'",
    { type: QueryTypes.SELECT },
  );
  if (existing.length) {
    console.log('uniq_shift_slot already exists, skipping');
    process.exit(0);
  }

  // Safety: refuse if exact duplicates still exist.
  const [dups]: any = await sequelize.query(
    `SELECT COALESCE(SUM(c-1),0) extras FROM (
       SELECT guardId, stationId, startTime, endTime, COUNT(*) c
       FROM shifts GROUP BY tenantId, guardId, stationId, startTime, endTime HAVING c > 1
     ) x`,
    { type: QueryTypes.SELECT },
  );
  if (Number(dups.extras) > 0) {
    console.error(`Refusing: ${dups.extras} duplicate shift rows still exist. De-duplicate first.`);
    process.exit(1);
  }

  await sequelize.query(
    'ALTER TABLE shifts ADD UNIQUE INDEX uniq_shift_slot (tenantId, guardId, stationId, startTime, endTime)',
  );
  console.log('✅ uniq_shift_slot created');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
