require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    // Add placeType column if not exists
    let tableDesc;
    try {
      tableDesc = await queryInterface.describeTable('visitorLogs');
    } catch (err) {
      console.error('visitorLogs table does not exist; cannot add placeType');
      process.exit(1);
    }

    if (tableDesc && 'placeType' in tableDesc) {
      console.log('Column placeType already exists on visitorLogs, skipping');
      process.exit(0);
    }

    console.log('Adding placeType column to visitorLogs...');
    await queryInterface.addColumn('visitorLogs', 'placeType', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });

    console.log('✅ placeType column added to visitorLogs');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
