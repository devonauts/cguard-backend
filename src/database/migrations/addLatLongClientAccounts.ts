/**
 * Migration script to add latitude/longitude to clientAccounts
 * Safe to run multiple times; will skip if columns exist.
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add latitude/longitude to clientAccounts...');

    // Check if columns already exist
    const [results] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_NAME = 'clientAccounts' AND COLUMN_NAME IN ('latitude','longitude')`
    );

    const existing = new Set((results as Array<{ COLUMN_NAME: string }>).map(r => r.COLUMN_NAME));

    if (!existing.has('latitude')) {
      console.log('Adding column: latitude');
      await queryInterface.addColumn('clientAccounts', 'latitude', {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      });
    } else {
      console.log('Column latitude already exists, skipping.');
    }

    if (!existing.has('longitude')) {
      console.log('Adding column: longitude');
      await queryInterface.addColumn('clientAccounts', 'longitude', {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      });
    } else {
      console.log('Column longitude already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
