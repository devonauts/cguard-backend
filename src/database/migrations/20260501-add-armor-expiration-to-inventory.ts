require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add `armorExpirationDate` column to inventories...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'inventories' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table inventories does not exist. Abort.');
      process.exit(0);
    }

    const [colResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventories' AND COLUMN_NAME = 'armorExpirationDate' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((colResult as any[]).length === 0) {
      console.log('Adding column: armorExpirationDate');
      await queryInterface.addColumn('inventories', 'armorExpirationDate', {
        type: DataTypes.DATEONLY,
        allowNull: true,
      });
      console.log('Column armorExpirationDate added.');
    } else {
      console.log('Column armorExpirationDate already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
