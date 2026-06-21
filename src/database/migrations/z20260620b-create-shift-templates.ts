require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    let tableExists = true;
    try {
      await queryInterface.describeTable('shiftTemplates');
    } catch (err) {
      tableExists = false;
    }

    if (tableExists) {
      console.log('Table shiftTemplates already exists, skipping creation');
      process.exit(0);
    }

    console.log('Creating shiftTemplates table...');

    await queryInterface.createTable('shiftTemplates', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      templateName: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      startTime: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      endTime: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      repeatShift: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      repeatBy: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      skillSet: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      department: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      breakDuration: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      category: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'active',
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

    await queryInterface.addIndex('shiftTemplates', ['tenantId']);
    await queryInterface.addIndex('shiftTemplates', ['status']);

    console.log('✅ shiftTemplates table created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
