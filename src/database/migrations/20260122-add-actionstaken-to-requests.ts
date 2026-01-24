require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding actionsTaken to requests table...');

    const tableDesc = await queryInterface.describeTable('requests');

    if (!tableDesc['actionsTaken']) {
      await queryInterface.addColumn('requests', 'actionsTaken', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
      console.log('Column actionsTaken added');
    } else {
      console.log('Column actionsTaken already exists, skipping');
    }

    console.log('✅ actionsTaken migration complete');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
