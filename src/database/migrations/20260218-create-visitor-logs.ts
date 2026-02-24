require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    // Check if table already exists; if so, skip creation (idempotent migration)
    let tableExists = true;
    try {
      await queryInterface.describeTable('visitorLogs');
    } catch (err) {
      tableExists = false;
    }

    if (tableExists) {
      console.log('Table visitorLogs already exists, skipping creation');
      process.exit(0);
    }

    console.log('Creating visitorLogs table...');

    await queryInterface.createTable('visitorLogs', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      visitDate: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      lastName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      firstName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      idNumber: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      exitTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      numPeople: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenants',
          key: 'id',
        },
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

    console.log('Creating indexes for visitorLogs...');
    await queryInterface.addIndex('visitorLogs', ['tenantId']);
    await queryInterface.addIndex('visitorLogs', ['idNumber']);

    console.log('✅ visitorLogs created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
