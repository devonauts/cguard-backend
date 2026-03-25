require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding stationId to requests table...');

    const tableDesc = await queryInterface.describeTable('requests');

    if (!tableDesc['stationId']) {
      await queryInterface.addColumn('requests', 'stationId', {
        type: DataTypes.UUID,
        allowNull: true,
        // optional: add references if you have a stations table
        // references: { model: 'stations', key: 'id' },
        // onUpdate: 'CASCADE',
        // onDelete: 'SET NULL',
      });
      console.log('Added column stationId to requests');
    } else {
      console.log('Column stationId already exists, skipping');
    }

    console.log('✅ Migration complete');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
