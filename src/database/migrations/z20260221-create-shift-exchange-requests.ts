require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    let tableExists = true;
    try {
      await queryInterface.describeTable('shiftExchangeRequests');
    } catch (err) {
      tableExists = false;
    }

    if (tableExists) {
      console.log('Table shiftExchangeRequests already exists, skipping creation');
      process.exit(0);
    }

    console.log('Creating shiftExchangeRequests table...');

    await queryInterface.createTable('shiftExchangeRequests', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      requestDate: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      fromShiftId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      toShiftId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      fromGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      toGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('shiftExchangeRequests', ['tenantId']);
    await queryInterface.addIndex('shiftExchangeRequests', ['fromGuardId']);
    await queryInterface.addIndex('shiftExchangeRequests', ['toGuardId']);
    await queryInterface.addIndex('shiftExchangeRequests', ['status']);

    console.log('✅ shiftExchangeRequests table created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
