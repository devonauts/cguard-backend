require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add extra fields (website, licenseNumber, timezone) to tenants...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    // website
    const [websiteResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'website' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((websiteResult as any[]).length === 0) {
      console.log('Adding column: website');
      await queryInterface.addColumn('tenants', 'website', {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column website already exists, skipping.');
    }

    // licenseNumber
    const [licenseResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'licenseNumber' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((licenseResult as any[]).length === 0) {
      console.log('Adding column: licenseNumber');
      await queryInterface.addColumn('tenants', 'licenseNumber', {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column licenseNumber already exists, skipping.');
    }

    // timezone
    const [tzResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'timezone' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((tzResult as any[]).length === 0) {
      console.log('Adding column: timezone');
      await queryInterface.addColumn('tenants', 'timezone', {
        type: DataTypes.STRING(100),
        allowNull: false,
        defaultValue: 'UTC',
      });
    } else {
      console.log('Column timezone already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
