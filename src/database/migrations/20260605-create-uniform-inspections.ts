/**
 * Create the uniformInspections table — supervisor ratings of how correctly a
 * guard/supervisor is uniformed. Feeds the "uniform" performance factor.
 * Idempotent: skips if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260605-create-uniform-inspections.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) =>
    /^uniforminspections$/i.test(t),
  );
  if (exists) {
    console.log('Table uniformInspections already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('uniformInspections', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    inspectionDate: { type: DataTypes.DATE, allowNull: false },
    rating: { type: DataTypes.INTEGER, allowNull: false },
    stars: { type: DataTypes.INTEGER, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    photos: { type: DataTypes.TEXT, allowNull: true },
    subjectType: { type: DataTypes.ENUM('guard', 'supervisor'), allowNull: false, defaultValue: 'guard' },
    subjectUserId: { type: DataTypes.UUID, allowNull: false },
    securityGuardId: { type: DataTypes.UUID, allowNull: true },
    inspectorId: { type: DataTypes.UUID, allowNull: true },
    stationId: { type: DataTypes.UUID, allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  try {
    await qi.addIndex('uniformInspections', ['tenantId', 'subjectUserId', 'inspectionDate'], {
      name: 'uniformInspections_tenant_subject_date',
    });
    await qi.addIndex('uniformInspections', ['tenantId', 'securityGuardId'], {
      name: 'uniformInspections_tenant_guard',
    });
  } catch (e) {
    console.warn('index add skipped:', (e as Error).message);
  }

  console.log('✅ uniformInspections table created');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
