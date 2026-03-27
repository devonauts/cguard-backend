require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();
  try {
    console.log('Migration: ensure siteTour.deletedAt column exists');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'siteTours' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.warn('siteTours table does not exist; skipping');
      process.exit(0);
    }

    const [col] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'deletedAt' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((col as any[]).length === 0) {
      console.log('Adding deletedAt column to siteTours');
      await queryInterface.addColumn('siteTours', 'deletedAt', { type: DataTypes.DATE, allowNull: true });
    } else {
      console.log('deletedAt already exists on siteTours; nothing to do');
    }

    console.log('Migration completed');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

migrate();
