require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating incidentTypes table...');

    await queryInterface.createTable('incidentTypes', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
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
        references: {
          model: 'users',
          key: 'id',
        },
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id',
        },
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

    console.log('Adding indexes for incidentTypes...');
    await queryInterface.addIndex('incidentTypes', ['tenantId']);
    await queryInterface.addIndex('incidentTypes', ['name', 'tenantId']);
    await queryInterface.addIndex('incidentTypes', ['importHash', 'tenantId'], { unique: true, name: 'incidentTypes_importHash_tenant_unique' });

    console.log('Adding column incidentTypeId to incidents...');
    // Add column if not exists
    const tableDesc = await queryInterface.describeTable('incidents');
    if (!tableDesc['incidentTypeId']) {
      await queryInterface.addColumn('incidents', 'incidentTypeId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'incidentTypes',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    } else {
      console.log('Column incidentTypeId already exists on incidents, skipping addColumn.');
    }

    console.log('✅ incidentTypes and FK added');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
