/**
 * Add `emailOnComplete` (opt-in) to rondaSettings: when true, completing a ronda
 * emails the tenant's admins/supervisors. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260608-add-rondasettings-email-on-complete.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const describe = await qi.describeTable('rondaSettings');
  if ('emailOnComplete' in describe) {
    console.log('rondaSettings.emailOnComplete already exists, skipping');
    process.exit(0);
  }

  await qi.addColumn('rondaSettings', 'emailOnComplete', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });

  console.log('Added rondaSettings.emailOnComplete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
