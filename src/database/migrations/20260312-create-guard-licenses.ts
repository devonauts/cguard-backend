require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create guardLicenses table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'guardLicenses' AND TABLE_SCHEMA = DATABASE()`
    );

    if (tableExists) {
      console.log('Table guardLicenses already exists. Abort.');
      process.exit(0);
    }

    console.log('Creating table: guardLicenses');

    await queryInterface.createTable('guardLicenses', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      licenseTypeId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      customName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      number: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      issueDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expiryDate: {
        type: DataTypes.DATE,
        allowNull: true,
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

    await queryInterface.addIndex('guardLicenses', ['tenantId']);
    await queryInterface.addIndex('guardLicenses', ['guardId']);
    await queryInterface.addIndex('guardLicenses', ['licenseTypeId']);

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

migrate();
