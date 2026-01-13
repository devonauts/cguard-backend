require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add tax and tax snapshot columns to services...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'services' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table services does not exist. Abort.');
      process.exit(0);
    }

    // Ensure legacy simple `tax` column exists (string) - keep for compatibility
    const [colResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'tax' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((colResult as any[]).length === 0) {
      console.log('Adding column: tax');
      await queryInterface.addColumn('services', 'tax', {
        type: DataTypes.STRING(36),
        allowNull: true,
      });
    } else {
      console.log('Column tax already exists, skipping.');
    }

    // taxId
    const [taxIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'taxId' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((taxIdResult as any[]).length === 0) {
      console.log('Adding column: taxId');
      await queryInterface.addColumn('services', 'taxId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'taxes', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    } else {
      console.log('Column taxId already exists, skipping.');
    }

    // taxName
    const [taxNameResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'taxName' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((taxNameResult as any[]).length === 0) {
      console.log('Adding column: taxName');
      await queryInterface.addColumn('services', 'taxName', {
        type: DataTypes.STRING(150),
        allowNull: true,
      });
    } else {
      console.log('Column taxName already exists, skipping.');
    }

    // taxRate
    const [taxRateResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'taxRate' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((taxRateResult as any[]).length === 0) {
      console.log('Adding column: taxRate');
      await queryInterface.addColumn('services', 'taxRate', {
        type: DataTypes.DECIMAL(10,2),
        allowNull: true,
      });
    } else {
      console.log('Column taxRate already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
