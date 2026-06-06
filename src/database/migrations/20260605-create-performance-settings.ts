/**
 * Create the performanceSettings table — per-tenant overrides for the
 * performance-score knobs (weights, penalty constants, backup points). Every
 * column is nullable; the scoring service falls back to env then defaults.
 * Idempotent: skips if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260605-create-performance-settings.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) =>
    /^performancesettings$/i.test(t),
  );
  if (exists) {
    console.log('Table performanceSettings already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('performanceSettings', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    weightPunctuality: { type: DataTypes.FLOAT, allowNull: true },
    weightUniform: { type: DataTypes.FLOAT, allowNull: true },
    weightInventory: { type: DataTypes.FLOAT, allowNull: true },
    weightConsignas: { type: DataTypes.FLOAT, allowNull: true },
    weightRondas: { type: DataTypes.FLOAT, allowNull: true },
    weightQuiz: { type: DataTypes.FLOAT, allowNull: true },
    weightTraining: { type: DataTypes.FLOAT, allowNull: true },
    penaltyK: { type: DataTypes.FLOAT, allowNull: true },
    penaltyA: { type: DataTypes.FLOAT, allowNull: true },
    penaltyB: { type: DataTypes.FLOAT, allowNull: true },
    volunteerPoints: { type: DataTypes.INTEGER, allowNull: true },
    coverPoints: { type: DataTypes.INTEGER, allowNull: true },
    bonusCap: { type: DataTypes.INTEGER, allowNull: true },
    graceMinutes: { type: DataTypes.INTEGER, allowNull: true },
    lateFloorMinutes: { type: DataTypes.INTEGER, allowNull: true },
    expectedPatrolsPerShift: { type: DataTypes.INTEGER, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  try {
    await qi.addIndex('performanceSettings', ['tenantId'], {
      unique: true,
      name: 'performanceSettings_tenant',
    });
  } catch (e) {
    console.warn('index add skipped:', (e as Error).message);
  }

  console.log('✅ performanceSettings table created');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
