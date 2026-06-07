/**
 * Add `nickname` (nominativo / internal call-sign) to stations. PRIVATE to
 * tenant operations — client-portal endpoints select explicit attribute lists
 * that exclude it, so clients never see it. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260607-add-station-nickname.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const describe = await qi.describeTable('stations');
  if ('nickname' in describe) {
    console.log('stations.nickname already exists, skipping');
    process.exit(0);
  }

  await qi.addColumn('stations', 'nickname', {
    type: DataTypes.STRING(120),
    allowNull: true,
    defaultValue: null,
  });

  console.log('Added stations.nickname');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
