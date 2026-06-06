/**
 * Create the clockOutRequests table — guard early-clock-out approval requests.
 * Idempotent: skips if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260605-create-clock-out-requests.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) => /^clockoutrequests$/i.test(t));
  if (exists) {
    console.log('Table clockOutRequests already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('clockOutRequests', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    requestedAt: { type: DataTypes.DATE, allowNull: false },
    scheduledEnd: { type: DataTypes.DATE, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionNotes: { type: DataTypes.TEXT, allowNull: true },
    guardId: { type: DataTypes.UUID, allowNull: false },
    securityGuardId: { type: DataTypes.UUID, allowNull: true },
    guardShiftId: { type: DataTypes.UUID, allowNull: true },
    shiftId: { type: DataTypes.UUID, allowNull: true },
    stationId: { type: DataTypes.UUID, allowNull: true },
    decidedById: { type: DataTypes.UUID, allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  try {
    await qi.addIndex('clockOutRequests', ['tenantId', 'status'], {
      name: 'clockOutRequests_tenant_status',
    });
    await qi.addIndex('clockOutRequests', ['tenantId', 'guardId', 'status'], {
      name: 'clockOutRequests_tenant_guard_status',
    });
    await qi.addIndex('clockOutRequests', ['tenantId', 'guardShiftId'], {
      name: 'clockOutRequests_tenant_shift',
    });
  } catch (e) {
    console.warn('index add skipped:', (e as Error).message);
  }

  console.log('✅ clockOutRequests table created');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
