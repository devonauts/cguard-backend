require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Ensuring `internalNotes` column exists on requests...');

    const tableDesc = await queryInterface.describeTable('requests');

    if (!tableDesc['internalNotes']) {
      await queryInterface.addColumn('requests', 'internalNotes', {
        type: DataTypes.TEXT,
        allowNull: true,
      });

      console.log('✅ Added `internalNotes` to requests');
    } else {
      console.log('`internalNotes` already exists on requests, skipping.');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
