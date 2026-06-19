require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Clock-in WINDOW + late-approval feature:
 *   1. station.clockInEarlyBufferMin / station.clockInLateGraceMin — per-station
 *      override of the tenant Nómina window (null → fall back to tenant settings).
 *   2. clockInRequests table — a guard's request for permission to clock in late;
 *      a supervisor approves/rejects it in the CRM (mirrors clockOutRequests).
 * Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    // ── 1. Per-station buffer columns ─────────────────────────────────────────
    const stationTable = await qi.describeTable('stations');
    if (!stationTable.clockInEarlyBufferMin) {
      console.log('Adding stations.clockInEarlyBufferMin...');
      await qi.addColumn('stations', 'clockInEarlyBufferMin', {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null,
        comment: 'Per-station minutes before scheduled start the clock-in window opens (null → tenant setting)',
      });
      console.log('✅ stations.clockInEarlyBufferMin added');
    } else {
      console.log('stations.clockInEarlyBufferMin exists, skipping');
    }
    if (!stationTable.clockInLateGraceMin) {
      console.log('Adding stations.clockInLateGraceMin...');
      await qi.addColumn('stations', 'clockInLateGraceMin', {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null,
        comment: 'Per-station grace minutes after scheduled start before clock-in needs approval (null → tenant setting)',
      });
      console.log('✅ stations.clockInLateGraceMin added');
    } else {
      console.log('stations.clockInLateGraceMin exists, skipping');
    }

    // ── 2. clockInRequests table ──────────────────────────────────────────────
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'clockInRequests' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!tableExists) {
      console.log('Creating clockInRequests table...');
      await qi.createTable('clockInRequests', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        // securityGuard id
        guardId: { type: DataTypes.UUID, allowNull: true },
        // user id (matches shift.guardId / currentUser.id)
        guardUserId: { type: DataTypes.UUID, allowNull: false },
        stationId: { type: DataTypes.UUID, allowNull: true },
        shiftId: { type: DataTypes.UUID, allowNull: true },
        scheduledStart: { type: DataTypes.DATE, allowNull: true },
        reason: { type: DataTypes.TEXT, allowNull: true },
        status: {
          type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled', 'expired', 'used'),
          allowNull: false,
          defaultValue: 'pending',
        },
        approvedById: { type: DataTypes.UUID, allowNull: true },
        approvedAt: { type: DataTypes.DATE, allowNull: true },
        decisionNotes: { type: DataTypes.TEXT, allowNull: true },
        expiresAt: { type: DataTypes.DATE, allowNull: true },
        createdById: { type: DataTypes.UUID, allowNull: true },
        updatedById: { type: DataTypes.UUID, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('clockInRequests', ['tenantId', 'status']);
      await qi.addIndex('clockInRequests', ['tenantId', 'guardUserId', 'status']);
      await qi.addIndex('clockInRequests', ['tenantId', 'stationId', 'status']);
      console.log('✅ clockInRequests created.');
    } else {
      console.log('Table clockInRequests already exists. Skipping create.');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
