require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Adds `serviceConfig` JSON column to businessInfos.
 * Stores service-type-specific operational configuration
 * (guard count, equipment, SLAs, patrol frequency, etc.)
 * Also ensures `serviceType` column exists (idempotent).
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    const cols = await queryInterface.describeTable('businessInfos');

    if (!cols['serviceConfig']) {
      await queryInterface.addColumn('businessInfos', 'serviceConfig', {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      });
      console.log('✓ serviceConfig column added to businessInfos');
    } else {
      console.log('✓ serviceConfig already exists, skipping');
    }

    if (!cols['serviceType']) {
      await queryInterface.addColumn('businessInfos', 'serviceType', {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
      });
      console.log('✓ serviceType column added to businessInfos');
    } else {
      console.log('✓ serviceType already exists, skipping');
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
