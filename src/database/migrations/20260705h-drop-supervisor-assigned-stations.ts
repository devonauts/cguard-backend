/**
 * Drop `supervisorProfiles.assignedStationIds` — superseded by the puesto's
 * `supervisorPositions.stationIds` (station coverage belongs to the position, not
 * the person). Idempotent; only test data existed. Correct camelCase table name.
 *
 * Run: npx ts-node src/database/migrations/20260705h-drop-supervisor-assigned-stations.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('supervisorProfiles'); } catch { process.exit(0); }

  if ('assignedStationIds' in desc) {
    await qi.removeColumn('supervisorProfiles', 'assignedStationIds');
    console.log('Dropped supervisorProfiles.assignedStationIds');
  } else {
    console.log('supervisorProfiles.assignedStationIds already absent, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
