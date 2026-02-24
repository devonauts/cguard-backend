require('dotenv').config();

import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  // Require models dynamically
  const models = require('../models').default;
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating tenants table...');

    // If table exists, skip
    try {
      await queryInterface.describeTable('tenants');
      console.log('tenants already exists, skipping');
      process.exit(0);
    } catch (e) {
      // continue to create
    }

    await queryInterface.createTable('tenants', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      url: {
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

    console.log('✅ tenants created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
