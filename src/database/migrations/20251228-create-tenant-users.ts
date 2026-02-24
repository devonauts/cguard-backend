require('dotenv').config();

import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  // Require models dynamically to avoid module-eval initialization issues
  const models = require('../models').default;
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating tenantUsers table...');

    // If table exists, skip
    try {
      await queryInterface.describeTable('tenantUsers');
      console.log('tenantUsers already exists, skipping');
      process.exit(0);
    } catch (e) {
      // continue to create
    }

    await queryInterface.createTable('tenantUsers', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
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
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      roles: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      invitationToken: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      invitationTokenExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(255),
        allowNull: false,
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

    console.log('✅ tenantUsers created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
