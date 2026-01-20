require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: make tenants.url nullable with default ""...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    const [columnResult] = await sequelize.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'url' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((columnResult as any[]).length === 0) {
      console.log('Column url does not exist on tenants table. Skipping.');
      process.exit(0);
    }

    console.log('Altering column: url to allow NULL and default ""');
    await queryInterface.changeColumn('tenants', 'url', {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: '',
    });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
