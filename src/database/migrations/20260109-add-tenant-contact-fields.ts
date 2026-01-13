require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add contact and business fields to tenants...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    // address
    const [addressResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'address' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((addressResult as any[]).length === 0) {
      console.log('Adding column: address');
      await queryInterface.addColumn('tenants', 'address', {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column address already exists, skipping.');
    }

    // phone
    const [phoneResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'phone' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((phoneResult as any[]).length === 0) {
      console.log('Adding column: phone');
      await queryInterface.addColumn('tenants', 'phone', {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column phone already exists, skipping.');
    }

    // email
    const [emailResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'email' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((emailResult as any[]).length === 0) {
      console.log('Adding column: email');
      await queryInterface.addColumn('tenants', 'email', {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column email already exists, skipping.');
    }

    // logoId (optional)
    const [logoIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'logoId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((logoIdResult as any[]).length === 0) {
      console.log('Adding column: logoId');
      await queryInterface.addColumn('tenants', 'logoId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'files', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    } else {
      console.log('Column logoId already exists, skipping.');
    }

    // taxNumber
    const [taxNumberResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'taxNumber' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((taxNumberResult as any[]).length === 0) {
      console.log('Adding column: taxNumber');
      await queryInterface.addColumn('tenants', 'taxNumber', {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column taxNumber already exists, skipping.');
    }

    // businessTitle
    const [businessTitleResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'businessTitle' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((businessTitleResult as any[]).length === 0) {
      console.log('Adding column: businessTitle');
      await queryInterface.addColumn('tenants', 'businessTitle', {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column businessTitle already exists, skipping.');
    }

    // extraLines
    const [extraLinesResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = 'extraLines' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((extraLinesResult as any[]).length === 0) {
      console.log('Adding column: extraLines');
      await queryInterface.addColumn('tenants', 'extraLines', {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
      });
    } else {
      console.log('Column extraLines already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
