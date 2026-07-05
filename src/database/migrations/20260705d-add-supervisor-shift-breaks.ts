/**
 * Add break tracking to supervisorShifts: a JSON array of {start,end} periods so
 * the supervisor app can start/end breaks during a shift (like a punch clock).
 * Additive/nullable → no impact on existing rows. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260705d-add-supervisor-shift-breaks.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('supervisorShifts'); } catch { process.exit(0); }

  if (!('breaks' in desc)) {
    await qi.addColumn('supervisorShifts', 'breaks', { type: DataTypes.JSON, allowNull: true });
    console.log('Added supervisorShifts.breaks');
  } else { console.log('supervisorShifts.breaks exists, skipping'); }

  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
