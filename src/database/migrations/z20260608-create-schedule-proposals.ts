require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Phase 1 (draft-spine) staging tables for the scheduler:
 *   scheduleProposals  — a draft horario pending review/publish
 *   proposedShifts     — the staged shift diff (add/remove/change/keep) for it
 * Live `shift` rows are never touched until a proposal is published.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const exists = async (table: string) => {
    try {
      await qi.describeTable(table);
      return true;
    } catch {
      return false;
    }
  };

  try {
    if (!(await exists('scheduleProposals'))) {
      console.log('Creating scheduleProposals table...');
      await qi.createTable('scheduleProposals', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        title: { type: DataTypes.STRING(200), allowNull: true },
        scope: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'station' },
        stationId: { type: DataTypes.UUID, allowNull: true },
        postSiteId: { type: DataTypes.UUID, allowNull: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
        windowStart: { type: DataTypes.DATE, allowNull: true },
        windowEnd: { type: DataTypes.DATE, allowNull: true },
        params: { type: DataTypes.JSON, allowNull: true },
        summary: { type: DataTypes.JSON, allowNull: true },
        generatedById: { type: DataTypes.UUID, allowNull: true },
        approvedById: { type: DataTypes.UUID, allowNull: true },
        approvedAt: { type: DataTypes.DATE, allowNull: true },
        publishedAt: { type: DataTypes.DATE, allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('scheduleProposals', ['tenantId', 'status']);
      await qi.addIndex('scheduleProposals', ['tenantId', 'stationId']);
      await qi.addIndex('scheduleProposals', ['tenantId', 'postSiteId']);
      console.log('✅ scheduleProposals created');
    } else {
      console.log('scheduleProposals already exists, skipping');
    }

    if (!(await exists('proposedShifts'))) {
      console.log('Creating proposedShifts table...');
      await qi.createTable('proposedShifts', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        proposalId: { type: DataTypes.UUID, allowNull: false },
        action: { type: DataTypes.STRING(10), allowNull: false },
        guardId: { type: DataTypes.UUID, allowNull: true },
        stationId: { type: DataTypes.UUID, allowNull: true },
        positionId: { type: DataTypes.UUID, allowNull: true },
        guardAssignmentId: { type: DataTypes.UUID, allowNull: true },
        postSiteId: { type: DataTypes.UUID, allowNull: true },
        startTime: { type: DataTypes.DATE, allowNull: true },
        endTime: { type: DataTypes.DATE, allowNull: true },
        targetShiftId: { type: DataTypes.UUID, allowNull: true },
        meta: { type: DataTypes.JSON, allowNull: true },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('proposedShifts', ['tenantId', 'proposalId']);
      await qi.addIndex('proposedShifts', ['proposalId', 'action']);
      console.log('✅ proposedShifts created');
    } else {
      console.log('proposedShifts already exists, skipping');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
