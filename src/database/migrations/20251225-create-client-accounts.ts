require('dotenv').config();

import { QueryInterface, DataTypes } from 'sequelize';
import models from '../models';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create clientAccounts table...');

    // If tenants table doesn't exist, instruct the user to run tenants migration first
    try {
      await queryInterface.describeTable('tenants');
    } catch (err) {
      console.error('Required parent table `tenants` does not exist. Run the migration that creates tenants first.');
      process.exit(1);
    }

    await queryInterface.createTable('clientAccounts', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING(200), allowNull: false },
      lastName: { type: DataTypes.STRING(200), allowNull: true },
      email: { type: DataTypes.STRING(150), allowNull: true },
      phoneNumber: { type: DataTypes.STRING(20), allowNull: true },
      address: { type: DataTypes.STRING(200), allowNull: false },
      addressComplement: { type: DataTypes.STRING(200), allowNull: true },
      zipCode: { type: DataTypes.STRING(20), allowNull: true },
      city: { type: DataTypes.STRING(100), allowNull: true },
      country: { type: DataTypes.STRING(100), allowNull: true },
      useSameAddressForBilling: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      faxNumber: { type: DataTypes.STRING(20), allowNull: true },
      website: { type: DataTypes.STRING(255), allowNull: true },
      latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
      importHash: { type: DataTypes.STRING(255), allowNull: true },
      categoryIds: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    // Add indexes similar to the model (skip if already present)
    try {
      const existing = await queryInterface.showIndex('clientAccounts');
      const hasIndex = Array.isArray(existing) && existing.some((i: any) => i && i.name === 'clientAccounts_importHash_tenantId_unique');
      if (!hasIndex) {
        await queryInterface.addIndex('clientAccounts', ['importHash', 'tenantId'], {
          unique: true,
          name: 'clientAccounts_importHash_tenantId_unique',
          where: { deletedAt: null },
        });
      } else {
        console.log('Index clientAccounts_importHash_tenantId_unique already exists, skipping');
      }
    } catch (err) {
      // In case showIndex is not supported or fails, try to add and ignore duplicate-key errors
      try {
        await queryInterface.addIndex('clientAccounts', ['importHash', 'tenantId'], {
          unique: true,
          name: 'clientAccounts_importHash_tenantId_unique',
          where: { deletedAt: null },
        });
      } catch (e) {
        console.log('Could not add index (may already exist), continuing');
      }
    }

    console.log('✅ clientAccounts created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
