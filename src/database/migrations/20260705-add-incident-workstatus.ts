/**
 * Add `incidents.workStatus` (open | inProgress | resolved | closed) so a
 * supervisor's granular status is visible in the CRM instead of being collapsed
 * to the binary `status`. Additive/nullable (default 'open'); the binary
 * `status` column stays the legacy source of truth. Idempotent.
 *
 * Backfills existing rows: cerrado → 'closed', else 'open'.
 *
 * Run: npx ts-node src/database/migrations/20260705-add-incident-workstatus.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  let desc: any = {};
  try { desc = await qi.describeTable('incidents'); } catch { process.exit(0); }

  if (!('workStatus' in desc)) {
    await qi.addColumn('incidents', 'workStatus', { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'open' });
    console.log('Added incidents.workStatus');
    // Backfill from the binary status.
    await sequelize.query(`UPDATE incidents SET workStatus = CASE WHEN status = 'cerrado' THEN 'closed' ELSE 'open' END WHERE workStatus IS NULL`);
    console.log('Backfilled incidents.workStatus');
  } else {
    console.log('incidents.workStatus already exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
