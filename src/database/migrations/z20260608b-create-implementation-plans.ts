require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Phase 2 (notifications) tables:
 *   implementationPlans      — roll-out record per published proposal
 *   implementationPlanItems  — per-affected-guard changes + notify status
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const exists = async (table: string) => {
    try { await qi.describeTable(table); return true; } catch { return false; }
  };

  const tenantFk = {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  };

  try {
    if (!(await exists('implementationPlans'))) {
      console.log('Creating implementationPlans table...');
      await qi.createTable('implementationPlans', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        proposalId: { type: DataTypes.UUID, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
        totalGuards: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        notifiedGuards: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        publishedById: { type: DataTypes.UUID, allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        tenantId: tenantFk,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('implementationPlans', ['tenantId', 'proposalId']);
      console.log('✅ implementationPlans created');
    } else {
      console.log('implementationPlans already exists, skipping');
    }

    if (!(await exists('implementationPlanItems'))) {
      console.log('Creating implementationPlanItems table...');
      await qi.createTable('implementationPlanItems', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        planId: { type: DataTypes.UUID, allowNull: false },
        guardId: { type: DataTypes.UUID, allowNull: false },
        added: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        removed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        changed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        details: { type: DataTypes.JSON, allowNull: true },
        notifyStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
        channels: { type: DataTypes.JSON, allowNull: true },
        notifiedAt: { type: DataTypes.DATE, allowNull: true },
        tenantId: tenantFk,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('implementationPlanItems', ['tenantId', 'planId']);
      await qi.addIndex('implementationPlanItems', ['planId', 'guardId']);
      console.log('✅ implementationPlanItems created');
    } else {
      console.log('implementationPlanItems already exists, skipping');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
