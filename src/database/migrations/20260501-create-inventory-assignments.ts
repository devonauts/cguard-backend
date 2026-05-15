require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create inventory_assignments table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'inventoryAssignments' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (!tableExists) {
      await queryInterface.createTable('inventoryAssignments', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        inventoryItemId: { type: DataTypes.UUID, allowNull: false },
        stationId: { type: DataTypes.UUID, allowNull: true },
        postSiteId: { type: DataTypes.UUID, allowNull: true },
        assignedToUserId: { type: DataTypes.UUID, allowNull: true },
        assignedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        returnedAt: { type: DataTypes.DATE, allowNull: true },
        conditionAtCheckout: { type: DataTypes.ENUM('bueno','regular','dañado'), allowNull: true },
        conditionAtReturn: { type: DataTypes.ENUM('bueno','regular','dañado'), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        returnNotes: { type: DataTypes.TEXT, allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table inventoryAssignments created.');
    } else {
      console.log('Table inventoryAssignments already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
