require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add column lastLoginAt to users...');

    // Verify table exists (accept both `users` and `user`)
    const [[tableRow]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE (TABLE_NAME = 'users' OR TABLE_NAME = 'user') AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableRow) {
      console.log('Table users/user does not exist. Abort.');
      process.exit(0);
    }

    const tableName = tableRow.TABLE_NAME || tableRow.table_name || Object.values(tableRow)[0];

    const [colResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tableName}' AND COLUMN_NAME = 'lastLoginAt' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((colResult as any[]).length === 0) {
      console.log(`Adding column: lastLoginAt to table ${tableName}`);
      await queryInterface.addColumn(tableName, 'lastLoginAt', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    } else {
      console.log('Column lastLoginAt already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
