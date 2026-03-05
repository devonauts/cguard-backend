require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add postSiteId/tenantId/createdById/updatedById to siteTours...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'siteTours' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table siteTours does not exist. Abort.');
      process.exit(0);
    }

    // postSiteId
    const [postSiteIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'postSiteId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((postSiteIdResult as any[]).length === 0) {
      console.log('Adding column: postSiteId');
      await queryInterface.addColumn('siteTours', 'postSiteId', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column postSiteId already exists, skipping.');
    }

    // tenantId
    const [tenantIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'tenantId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((tenantIdResult as any[]).length === 0) {
      console.log('Adding column: tenantId');
      await queryInterface.addColumn('siteTours', 'tenantId', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column tenantId already exists, skipping.');
    }

    // createdById
    const [createdByIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'createdById' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((createdByIdResult as any[]).length === 0) {
      console.log('Adding column: createdById');
      await queryInterface.addColumn('siteTours', 'createdById', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column createdById already exists, skipping.');
    }

    // updatedById
    const [updatedByIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTours' AND COLUMN_NAME = 'updatedById' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((updatedByIdResult as any[]).length === 0) {
      console.log('Adding column: updatedById');
      await queryInterface.addColumn('siteTours', 'updatedById', {
        type: DataTypes.UUID,
        allowNull: true,
      });
    } else {
      console.log('Column updatedById already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
