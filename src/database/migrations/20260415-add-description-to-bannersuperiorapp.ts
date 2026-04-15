require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add description to bannerSuperiorApp table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN ('bannerSuperiorApp', 'bannerSuperiorApps') AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table bannerSuperiorApp / bannerSuperiorApps does not exist. Abort.');
      process.exit(0);
    }

    const tableName = String(tableExists.TABLE_NAME || tableExists.table_name || tableExists.TABLE_NAME || tableExists.tableName || 'bannerSuperiorApps');

    const [descriptionResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tableName}' AND COLUMN_NAME = 'description' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((descriptionResult as any[]).length === 0) {
      console.log('Adding column: description');
      await queryInterface.addColumn(tableName, 'description', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
    } else {
      console.log('Column description already exists, skipping.');
    }

    console.log('✅ Migration completed.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
