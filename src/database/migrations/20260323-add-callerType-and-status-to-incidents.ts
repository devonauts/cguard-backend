require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding callerType and status to incidents table...');

    const tableDesc = await queryInterface.describeTable('incidents');

    if (!tableDesc['callerType']) {
      await queryInterface.addColumn('incidents', 'callerType', {
        type: DataTypes.STRING(50),
        allowNull: true,
      });
      console.log('Added column callerType to incidents');
    } else {
      console.log('Column callerType already exists, skipping');
    }

    if (!tableDesc['status']) {
      await queryInterface.addColumn('incidents', 'status', {
        type: DataTypes.STRING(50),
        allowNull: true,
      });
      console.log('Added column status to incidents');
    } else {
      console.log('Column status already exists, skipping');
    }

    console.log('✅ Migration complete');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
