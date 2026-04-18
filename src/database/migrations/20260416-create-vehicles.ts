require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create vehicles table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'vehicles' AND TABLE_SCHEMA = DATABASE()`
    );

    if (tableExists) {
      console.log('Table vehicles already exists. Abort.');
      process.exit(0);
    }

    console.log('Creating table: vehicles');

    await queryInterface.createTable('vehicles', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      licensePlate: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      make: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      model: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      year: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      color: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      vin: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      initialMileage: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
      },
      ownership: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: sequelize.fn('NOW'),
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: sequelize.fn('NOW'),
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('vehicles', ['tenantId']);
    await queryInterface.addIndex('vehicles', ['licensePlate']);
    await queryInterface.addIndex('vehicles', ['active']);

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

migrate();
