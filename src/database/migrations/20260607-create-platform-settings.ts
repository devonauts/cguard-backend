/**
 * Create the platformSettings table — platform-level key/value config managed
 * from the superadmin panel (e.g. Stripe keys). Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260607-create-platform-settings.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) => /^platformsettings$/i.test(t));
  if (exists) {
    console.log('Table platformSettings already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('platformSettings', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    value: { type: DataTypes.JSON, allowNull: true },
    updatedByUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await qi.addIndex('platformSettings', ['key'], { unique: true, name: 'platform_settings_key_unique' });

  console.log('Created table platformSettings');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
