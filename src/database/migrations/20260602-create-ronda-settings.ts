/**
 * Create the rondaSettings table (Configuraciones de rondas).
 * Idempotent: skips if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260602-create-ronda-settings.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) => /^rondasettings$/i.test(t));
  if (exists) {
    console.log('Table rondaSettings already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('rondaSettings', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    postSiteId: { type: DataTypes.UUID, allowNull: true },
    frequencyMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    roundsPerShift: { type: DataTypes.INTEGER, allowNull: true },
    graceMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    maxDurationMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    requirePhoto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requireGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    geofenceRadius: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
    requireNote: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    notifyTenantOnStart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyTenantOnComplete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyTenantOnMissed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyClient: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    importHash: { type: DataTypes.STRING(255), allowNull: true },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  try {
    await qi.addIndex('rondaSettings', ['tenantId', 'postSiteId'], {
      unique: true,
      name: 'rondaSettings_tenant_postsite',
    });
  } catch (e) {
    console.warn('index add skipped:', (e as Error).message);
  }

  console.log('✅ rondaSettings table created');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
