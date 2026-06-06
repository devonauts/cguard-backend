/**
 * Add idx_guardshift_active (tenantId, guardNameId, punchOutTime) on guardShifts.
 * Speeds the "active record" lookup (punchOutTime IS NULL) used by the polled
 * guardMe dashboard, clock-out, and the clock-out-request endpoints.
 * Idempotent: skips if the index already exists.
 *
 * Run: npx ts-node src/database/migrations/20260606-add-guardshift-active-index.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const table = 'guardShifts';

  try {
    const existing: any[] = await qi.showIndex(table) as any[];
    if (existing.some((i) => i.name === 'idx_guardshift_active')) {
      console.log('idx_guardshift_active already exists, skipping');
      process.exit(0);
    }
  } catch (e) {
    console.warn('showIndex failed (continuing):', (e as Error).message);
  }

  await qi.addIndex(table, ['tenantId', 'guardNameId', 'punchOutTime'], {
    name: 'idx_guardshift_active',
  });

  console.log('✅ added idx_guardshift_active on guardShifts');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
