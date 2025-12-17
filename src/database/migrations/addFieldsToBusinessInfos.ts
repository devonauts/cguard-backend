require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add fields to businessInfos...');

    // Verify table exists
    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'businessInfos' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table businessInfos does not exist. Abort.');
      process.exit(0);
    }

    // Add latitud
    const [latResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'latitud' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((latResult as any[]).length === 0) {
      console.log('Adding column: latitud');
      await queryInterface.addColumn('businessInfos', 'latitud', {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    } else {
      console.log('Column latitud already exists, skipping.');
    }

    // Add longitud
    const [longResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'longitud' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((longResult as any[]).length === 0) {
      console.log('Adding column: longitud');
      await queryInterface.addColumn('businessInfos', 'longitud', {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    } else {
      console.log('Column longitud already exists, skipping.');
    }

    // Add categoryIds (JSON)
    const [catResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'categoryIds' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((catResult as any[]).length === 0) {
      console.log('Adding column: categoryIds');
      await queryInterface.addColumn('businessInfos', 'categoryIds', {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      });
    } else {
      console.log('Column categoryIds already exists, skipping.');
    }

    // Add active (boolean)
    const [activeResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'active' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((activeResult as any[]).length === 0) {
      console.log('Adding column: active');
      await queryInterface.addColumn('businessInfos', 'active', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    } else {
      console.log('Column active already exists, skipping.');
    }

    // Add clientAccountId (FK to clientAccounts)
    const [clientAccResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'clientAccountId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((clientAccResult as any[]).length === 0) {
      console.log('Adding column: clientAccountId');
      await queryInterface.addColumn('businessInfos', 'clientAccountId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'clientAccounts',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    } else {
      console.log('Column clientAccountId already exists, skipping.');
    }

    // Add secondAddress
    const [secondAddrResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'secondAddress' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((secondAddrResult as any[]).length === 0) {
      console.log('Adding column: secondAddress');
      await queryInterface.addColumn('businessInfos', 'secondAddress', {
        type: DataTypes.STRING(200),
        allowNull: true,
      });
    } else {
      console.log('Column secondAddress already exists, skipping.');
    }

    // Add country
    const [countryResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'country' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((countryResult as any[]).length === 0) {
      console.log('Adding column: country');
      await queryInterface.addColumn('businessInfos', 'country', {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    } else {
      console.log('Column country already exists, skipping.');
    }

    // Add city
    const [cityResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'city' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((cityResult as any[]).length === 0) {
      console.log('Adding column: city');
      await queryInterface.addColumn('businessInfos', 'city', {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    } else {
      console.log('Column city already exists, skipping.');
    }

    // Add postalCode
    const [postalResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'businessInfos' AND COLUMN_NAME = 'postalCode' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((postalResult as any[]).length === 0) {
      console.log('Adding column: postalCode');
      await queryInterface.addColumn('businessInfos', 'postalCode', {
        type: DataTypes.STRING(20),
        allowNull: true,
      });
    } else {
      console.log('Column postalCode already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
