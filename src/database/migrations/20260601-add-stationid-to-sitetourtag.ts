/**
 * Add `stationId` to siteTourTags so QR checkpoints can be explicitly assigned
 * to a station (the web admin already sends stationId on create/update).
 *
 * Run: npx ts-node src/database/migrations/20260601-add-stationid-to-sitetourtag.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  const tables = await queryInterface.showAllTables();
  const table =
    (tables as string[]).find((t) => /^sitetourtags?$/i.test(t)) || 'siteTourTags';

  const desc = await queryInterface.describeTable(table);
  if (desc['stationId']) {
    console.log(`Column stationId already exists on ${table}, skipping`);
  } else {
    await queryInterface.addColumn(table, 'stationId', {
      type: DataTypes.UUID,
      allowNull: true,
    });
    console.log(`Added stationId to ${table}`);
  }
  console.log('✅ siteTourTag.stationId migration complete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
