/**
 * Add nominaSettings (TEXT/JSON, nullable) to the settings table — the
 * per-tenant Nómina / Time & Attendance configuration blob.
 *
 * Run: npx ts-node scripts/20260606-add-nomina-settings.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const table = (tables as string[]).find((t) => /^settings$/i.test(t)) || 'settings';

  const desc = await qi.describeTable(table);
  if (desc['nominaSettings']) {
    console.log(`Column nominaSettings already exists on ${table}, skipping`);
    process.exit(0);
  }

  await qi.addColumn(table, 'nominaSettings', {
    type: DataTypes.TEXT,
    allowNull: true,
  });
  console.log(`✅ Added nominaSettings to ${table}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
