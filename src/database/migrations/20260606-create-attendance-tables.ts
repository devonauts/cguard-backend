/**
 * Create the attendanceExceptions and attendanceCorrections tables for the
 * Nómina / Time & Attendance feature. Idempotent: skips tables that exist.
 *
 * Run: npx ts-node src/database/migrations/20260606-create-attendance-tables.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];

  if (!tables.some((t) => /^attendanceexceptions$/i.test(t))) {
    await qi.createTable('attendanceExceptions', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      type: { type: DataTypes.STRING(32), allowNull: false },
      severity: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'medium' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'open' },
      reason: { type: DataTypes.TEXT, allowNull: true },
      resolutionNotes: { type: DataTypes.TEXT, allowNull: true },
      detectedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      resolvedAt: { type: DataTypes.DATE, allowNull: true },
      meta: { type: DataTypes.TEXT, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      guardShiftId: { type: DataTypes.UUID, allowNull: true },
      shiftId: { type: DataTypes.UUID, allowNull: true },
      guardId: { type: DataTypes.UUID, allowNull: true },
      resolvedById: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    try {
      await qi.addIndex('attendanceExceptions', ['tenantId', 'status', 'type'], {
        name: 'attendanceExceptions_tenant_status_type',
      });
      await qi.addIndex('attendanceExceptions', ['shiftId', 'type'], {
        name: 'attendanceExceptions_shift_type',
      });
    } catch (e) {
      console.warn('index add skipped:', (e as Error).message);
    }
    console.log('✅ attendanceExceptions table created');
  } else {
    console.log('Table attendanceExceptions already exists, skipping');
  }

  if (!tables.some((t) => /^attendancecorrections$/i.test(t))) {
    await qi.createTable('attendanceCorrections', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      field: { type: DataTypes.STRING(64), allowNull: false },
      originalValue: { type: DataTypes.TEXT, allowNull: true },
      correctedValue: { type: DataTypes.TEXT, allowNull: true },
      reason: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      approvalNotes: { type: DataTypes.TEXT, allowNull: true },
      guardShiftId: { type: DataTypes.UUID, allowNull: true },
      requestedById: { type: DataTypes.UUID, allowNull: true },
      approvedById: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    try {
      await qi.addIndex('attendanceCorrections', ['tenantId', 'status'], {
        name: 'attendanceCorrections_tenant_status',
      });
    } catch (e) {
      console.warn('index add skipped:', (e as Error).message);
    }
    console.log('✅ attendanceCorrections table created');
  } else {
    console.log('Table attendanceCorrections already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
