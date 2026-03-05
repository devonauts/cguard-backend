require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add securityGuardId to siteTours...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'siteTours' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table siteTours does not exist. Abort.');
      process.exit(0);
    }

    const [colResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'securityGuardId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((colResult as any[]).length === 0) {
      console.log('Adding column: securityGuardId');
      await queryInterface.addColumn('siteTours', 'securityGuardId', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column securityGuardId already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
