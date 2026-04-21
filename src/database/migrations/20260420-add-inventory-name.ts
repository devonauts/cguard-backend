require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add `name` column to inventories...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'inventories' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table inventories does not exist. Abort.');
      process.exit(0);
    }

    const [colResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventories' AND COLUMN_NAME = 'name' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((colResult as any[]).length === 0) {
      console.log('Adding column: name');
      await queryInterface.addColumn('inventories', 'name', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
      console.log('Column name added.');
    } else {
      console.log('Column name already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
