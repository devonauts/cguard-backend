require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding importHash column to kpis...');

    await queryInterface.addColumn('kpis', 'importHash', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });

    console.log('✅ importHash added to kpis');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
