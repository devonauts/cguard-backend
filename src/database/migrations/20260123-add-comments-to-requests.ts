require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding comments field to requests table...');

    const tableDesc = await queryInterface.describeTable('requests');

    if (!tableDesc['comments']) {
      await queryInterface.addColumn('requests', 'comments', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    } else {
      console.log('Column comments already exists on requests, skipping addColumn.');
    }

    console.log('✅ Added comments field to requests');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
