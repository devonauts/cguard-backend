/**
 * radioCheckEntries.stationId NOT NULL → nullable. On-duty supervisors now answer
 * the roll call (pase de novedades) like guards, but they're roaming/mobile and
 * not bound to a station, so their entry carries a null stationId (targeting is by
 * guardUserId). changeColumn is safe to re-run.
 * Run: npx ts-node src/database/migrations/z20260707b-radiocheck-station-nullable.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const db = models();
  const qi: QueryInterface = db.sequelize.getQueryInterface();
  const table = db.radioCheckEntry.getTableName();
  await qi.changeColumn(table as any, 'stationId', { type: DataTypes.UUID, allowNull: true });
  console.log(`${JSON.stringify(table)}.stationId → nullable`);
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
