require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add stationId to siteTours...');

    const [col] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'stationId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((col as any[]).length === 0) {
      console.log('Adding stationId column to siteTours');
      await queryInterface.addColumn('siteTours', 'stationId', { type: DataTypes.UUID, allowNull: true });
      try {
        await queryInterface.addIndex('siteTours', ['stationId'], { name: 'idx_siteTours_stationId' });
      } catch (e) {
        // ignore
      }
      console.log('stationId column added.');
    } else {
      console.log('stationId column already exists, skipping');
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
