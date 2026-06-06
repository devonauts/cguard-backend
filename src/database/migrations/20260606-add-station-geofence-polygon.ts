/**
 * Add geofencePolygon (TEXT/JSON, nullable) to the stations table — an optional
 * polygon geofence ([{lat,lng},...]) that takes precedence over the radius.
 * Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260606-add-station-geofence-polygon.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const table = (tables as string[]).find((t) => /^stations$/i.test(t)) || 'stations';
  const desc = await qi.describeTable(table);
  if (desc['geofencePolygon']) {
    console.log(`Column geofencePolygon already exists on ${table}, skipping`);
    process.exit(0);
  }
  await qi.addColumn(table, 'geofencePolygon', { type: DataTypes.TEXT, allowNull: true });
  console.log(`✅ Added geofencePolygon to ${table}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
