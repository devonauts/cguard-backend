/**
 * Add per-checkpoint `geofenceRadius` (meters) to siteTourTags. Null = inherit
 * the station radius. Used by scan location verification. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260607-add-sitetourtag-geofence-radius.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const describe = await qi.describeTable('siteTourTags');
  if ('geofenceRadius' in describe) {
    console.log('siteTourTags.geofenceRadius already exists, skipping');
    process.exit(0);
  }

  await qi.addColumn('siteTourTags', 'geofenceRadius', {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  });

  console.log('Added siteTourTags.geofenceRadius');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
