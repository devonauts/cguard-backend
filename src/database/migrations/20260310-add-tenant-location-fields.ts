require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add tenant location fields (addressLine2, postalCode, city, country, latitude, longitude)...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tenants does not exist. Abort.');
      process.exit(0);
    }

    const checkAndAdd = async (columnName: string, definition: any, options?: any) => {
      const [res] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tenants' AND COLUMN_NAME = '${columnName}' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((res as any[]).length === 0) {
        console.log(`Adding column: ${columnName}`);
        await queryInterface.addColumn('tenants', columnName, definition, options || {});
      } else {
        console.log(`Column ${columnName} already exists, skipping.`);
      }
    };

    await checkAndAdd('addressLine2', { type: DataTypes.TEXT, allowNull: true, defaultValue: '' });
    await checkAndAdd('postalCode', { type: DataTypes.STRING(50), allowNull: true, defaultValue: '' });
    await checkAndAdd('city', { type: DataTypes.STRING(255), allowNull: true, defaultValue: '' });
    await checkAndAdd('country', { type: DataTypes.STRING(255), allowNull: true, defaultValue: '' });
    await checkAndAdd('latitude', { type: DataTypes.DOUBLE, allowNull: true });
    await checkAndAdd('longitude', { type: DataTypes.DOUBLE, allowNull: true });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
