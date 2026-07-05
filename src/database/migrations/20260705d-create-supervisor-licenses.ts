/**
 * Create the `supervisorLicenses` table (supervisor mirror of guardLicenses,
 * user-keyed). Front/back images live in `files` scoped to this table, so no
 * image columns here. Idempotent (skips if the table already exists).
 *
 * Run: npx ts-node src/database/migrations/20260705d-create-supervisor-licenses.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  // Skip if already created.
  try {
    await qi.describeTable('supervisorLicenses');
    console.log('supervisorLicenses already exists, skipping');
    process.exit(0);
  } catch { /* not present → create */ }

  await qi.createTable('supervisorLicenses', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    supervisorUserId: { type: DataTypes.UUID, allowNull: false },
    licenseTypeId: { type: DataTypes.UUID, allowNull: true },
    customName: { type: DataTypes.STRING(255), allowNull: true },
    number: { type: DataTypes.STRING(255), allowNull: true },
    issueDate: { type: DataTypes.DATE, allowNull: true },
    expiryDate: { type: DataTypes.DATE, allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
    createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    importHash: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await qi.addIndex('supervisorLicenses', ['tenantId']);
  await qi.addIndex('supervisorLicenses', ['supervisorUserId']);
  console.log('Created supervisorLicenses');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
