/**
 * Migration: add landline column to tenants table
 * Generated: 2026-03-17
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add landline to tenants...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    const [colResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'landline' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((colResult as any[]).length === 0) {
      console.log('Adding column: landline');
      await queryInterface.addColumn('tenants', 'landline', {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
      });
      console.log('Column landline added.');
    } else {
      console.log('Column landline already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
