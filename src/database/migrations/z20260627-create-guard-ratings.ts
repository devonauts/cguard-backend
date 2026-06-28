require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Create guardRatings — a customer's 1–5 rating + optional comment for a guard who
 * is/was on shift at one of the client's stations (POST /customer/guards/:guardId/
 * rating). Read by the CRM so the company sees per-guard client feedback.
 *
 * guardId references securityGuard.id (PK) — same column guardShift.guardNameId /
 * incident.guardNameId FK to. Idempotent: skips if the table already exists.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    let tableExists = true;
    try { await queryInterface.describeTable('guardRatings'); } catch { tableExists = false; }
    if (!tableExists) {
      console.log('Creating guardRatings table...');
      await queryInterface.createTable('guardRatings', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        clientAccountId: { type: DataTypes.UUID, allowNull: false },
        guardId: { type: DataTypes.UUID, allowNull: false },
        stationId: { type: DataTypes.UUID, allowNull: true },
        shiftId: { type: DataTypes.UUID, allowNull: true },
        rating: { type: DataTypes.INTEGER, allowNull: false },
        comment: { type: DataTypes.TEXT, allowNull: true },
        tenantId: {
          type: DataTypes.UUID, allowNull: false,
          references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        createdById: { type: DataTypes.UUID, allowNull: true },
        updatedById: { type: DataTypes.UUID, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await queryInterface.addIndex('guardRatings', ['tenantId', 'guardId']);
      await queryInterface.addIndex('guardRatings', ['tenantId', 'clientAccountId']);
      console.log('✅ guardRatings table created');
    } else {
      console.log('Table guardRatings already exists, skipping creation');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
