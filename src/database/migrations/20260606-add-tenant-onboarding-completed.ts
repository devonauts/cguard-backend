require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add onboardingCompleted to tenants...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    // onboardingCompleted
    const [onboardingCompletedResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'onboardingCompleted' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((onboardingCompletedResult as any[]).length === 0) {
      console.log('Adding column: onboardingCompleted');
      await queryInterface.addColumn('tenants', 'onboardingCompleted', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    } else {
      console.log('Column onboardingCompleted already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
