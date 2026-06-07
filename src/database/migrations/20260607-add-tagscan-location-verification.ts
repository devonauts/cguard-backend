/**
 * Add server-side location-verification columns to tagScans:
 *   - validLocation  (BOOLEAN, nullable): was the guard within the checkpoint geofence?
 *   - distanceMeters (FLOAT, nullable):   distance from the checkpoint at scan time.
 * Computed in siteTourService.recordTagScan. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260607-add-tagscan-location-verification.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const describe = await qi.describeTable('tagScans');

  if (!('validLocation' in describe)) {
    await qi.addColumn('tagScans', 'validLocation', {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: null,
    });
    console.log('Added tagScans.validLocation');
  } else {
    console.log('tagScans.validLocation already exists, skipping');
  }

  if (!('distanceMeters' in describe)) {
    await qi.addColumn('tagScans', 'distanceMeters', {
      type: DataTypes.FLOAT,
      allowNull: true,
      defaultValue: null,
    });
    console.log('Added tagScans.distanceMeters');
  } else {
    console.log('tagScans.distanceMeters already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
