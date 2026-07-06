/**
 * Create `appFeedbacks` — CRM user ratings of their C-Guard Pro experience.
 * Idempotent; correct camelCase table name.
 *
 * Run: npx ts-node src/database/migrations/20260706-create-app-feedback.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  try {
    await qi.describeTable('appFeedbacks');
    console.log('appFeedbacks already exists, skipping');
    process.exit(0);
  } catch { /* create */ }

  await qi.createTable('appFeedbacks', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    rating: { type: DataTypes.INTEGER, allowNull: false },
    comment: { type: DataTypes.TEXT, allowNull: true },
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'crm' },
    tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
    userId: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex('appFeedbacks', ['tenantId']);
  await qi.addIndex('appFeedbacks', ['rating']);
  console.log('Created appFeedbacks');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
