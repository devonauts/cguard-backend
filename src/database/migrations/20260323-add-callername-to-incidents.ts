require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding callerName to incidents table...');

    const tableDesc = await queryInterface.describeTable('incidents');

    if (!tableDesc['callerName']) {
      await queryInterface.addColumn('incidents', 'callerName', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
      console.log('Added column callerName to incidents');
    } else {
      console.log('Column callerName already exists, skipping');
    }

    console.log('✅ Migration complete');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
