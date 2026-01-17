require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add payments JSON column to invoices...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'invoices' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table invoices does not exist. Abort.');
      process.exit(0);
    }

    // Add payments column if not exists
    const [[colExists]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'invoices' AND COLUMN_NAME = 'payments' AND TABLE_SCHEMA = DATABASE()`
    );

    if (colExists) {
      console.log('Column payments already exists. Abort.');
      process.exit(0);
    }

    console.log('Altering table invoices: add column payments JSON');

    await queryInterface.addColumn('invoices', 'payments', {
      type: DataTypes.JSON,
      allowNull: true,
    });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
