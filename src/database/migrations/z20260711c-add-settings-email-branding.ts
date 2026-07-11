/**
 * settings.emailBranding — per-tenant transactional-email accent/header color
 * for the shared email shell. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260711c-add-settings-email-branding.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const cols: any = await qi.describeTable('settings');
  if (!cols.emailBranding) {
    await qi.addColumn('settings', 'emailBranding', { type: DataTypes.TEXT, allowNull: true });
    console.log('Added settings.emailBranding');
  } else {
    console.log('settings.emailBranding exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
