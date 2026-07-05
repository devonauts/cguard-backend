/**
 * Add `supervisorProfiles.assignedStationIds` (JSON) — the stations/sites a
 * supervisor oversees (their responsibility area). Plain id array, guard-safe
 * (NOT guardAssignment/guardShift — no shift generation). Additive/nullable,
 * idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260705c-supervisor-assigned-stations.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('supervisorProfiles'); } catch { process.exit(0); }

  if (!('assignedStationIds' in desc)) {
    await qi.addColumn('supervisorProfiles', 'assignedStationIds', { type: DataTypes.JSON, allowNull: true });
    console.log('Added supervisorProfiles.assignedStationIds');
  } else {
    console.log('supervisorProfiles.assignedStationIds exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
