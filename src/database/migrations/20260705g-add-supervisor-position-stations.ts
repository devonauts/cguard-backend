/**
 * Add `supervisorPositions.stationIds` (JSON) — the stations under a puesto's
 * protection. Additive/nullable, idempotent. Correct camelCase table name.
 *
 * Run: npx ts-node src/database/migrations/20260705g-add-supervisor-position-stations.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('supervisorPositions'); } catch { process.exit(0); }

  if (!('stationIds' in desc)) {
    await qi.addColumn('supervisorPositions', 'stationIds', { type: DataTypes.JSON, allowNull: true });
    console.log('Added supervisorPositions.stationIds');
  } else {
    console.log('supervisorPositions.stationIds exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
