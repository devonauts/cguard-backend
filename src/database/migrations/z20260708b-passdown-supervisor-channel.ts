/**
 * shiftPassdowns: support supervisor (roaming, tenant-wide) handovers.
 *  - add `channel` ('guard'|'supervisor', default 'guard')
 *  - add `instructionsJson` (supervisor instructions stored inline — no post-tasks)
 *  - relax `stationId` to nullable (a supervisor handover has no post)
 * Idempotent. Run: npx ts-node src/database/migrations/z20260708b-passdown-supervisor-channel.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const db = models();
  const qi: QueryInterface = db.sequelize.getQueryInterface();
  const table = db.shiftPassdown.getTableName();
  const cols: any = await qi.describeTable(table as any);

  if (!cols.channel) {
    await qi.addColumn(table as any, 'channel', { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'guard' });
    console.log('  + channel');
  } else console.log('  channel exists — skip');

  if (!cols.instructionsJson) {
    await qi.addColumn(table as any, 'instructionsJson', { type: DataTypes.TEXT, allowNull: true });
    console.log('  + instructionsJson');
  } else console.log('  instructionsJson exists — skip');

  // Relax stationId to nullable (safe to re-run).
  await qi.changeColumn(table as any, 'stationId', { type: DataTypes.UUID, allowNull: true });
  console.log('  stationId → nullable');

  console.log(`passdown supervisor channel ready on ${JSON.stringify(table)}`);
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
