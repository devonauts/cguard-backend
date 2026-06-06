/**
 * Create the backupEvents table — volunteer offers and confirmed shift
 * coverage. Feeds the "backup availability" performance bonus.
 * Idempotent: skips if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260605-create-backup-events.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) => /^backupevents$/i.test(t));
  if (exists) {
    console.log('Table backupEvents already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('backupEvents', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    kind: { type: DataTypes.ENUM('volunteer', 'cover'), allowNull: false },
    eventDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('offered', 'confirmed', 'rejected', 'cancelled'), allowNull: false, defaultValue: 'offered' },
    points: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    notes: { type: DataTypes.TEXT, allowNull: true },
    subjectType: { type: DataTypes.ENUM('guard', 'supervisor'), allowNull: false, defaultValue: 'guard' },
    subjectUserId: { type: DataTypes.UUID, allowNull: false },
    securityGuardId: { type: DataTypes.UUID, allowNull: true },
    shiftId: { type: DataTypes.UUID, allowNull: true },
    stationId: { type: DataTypes.UUID, allowNull: true },
    confirmedById: { type: DataTypes.UUID, allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  try {
    await qi.addIndex('backupEvents', ['tenantId', 'subjectUserId', 'eventDate'], {
      name: 'backupEvents_tenant_subject_date',
    });
    await qi.addIndex('backupEvents', ['tenantId', 'status'], {
      name: 'backupEvents_tenant_status',
    });
  } catch (e) {
    console.warn('index add skipped:', (e as Error).message);
  }

  console.log('✅ backupEvents table created');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
