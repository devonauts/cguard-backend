require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create roles table if not exists...');

    const [[tableRow]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'roles' AND TABLE_SCHEMA = DATABASE()`
    );

    if (tableRow) {
      console.log('Table roles already exists. Nothing to do.');
      process.exit(0);
    }

    console.log('Creating table: roles');

    await queryInterface.createTable('roles', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },
      permissions: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE },
      deletedAt: { type: DataTypes.DATE },
    });

    // Add unique index on slug + tenantId
    await queryInterface.addIndex('roles', ['slug', 'tenantId'], {
      unique: true,
      name: 'roles_slug_tenant_unique',
    });

    console.log('✅ roles table created successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
