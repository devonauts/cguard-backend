require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add serviceType column to businessInfos.
 * Values: manned | alarm | cctv | patrol | custody
 * Nullable — existing rows will be NULL until explicitly set.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    const cols = await queryInterface.describeTable('businessInfos');

    if (!cols['serviceType']) {
      await queryInterface.addColumn('businessInfos', 'serviceType', {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
      });
      console.log('✓ Added serviceType to businessInfos');
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
