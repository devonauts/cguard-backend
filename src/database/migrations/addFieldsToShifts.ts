require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add fields to shifts...');

    // Verify table exists
    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'shifts' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table shifts does not exist. Abort.');
      process.exit(0);
    }

    const columnsToAdd: Array<{ name: string; def: any }> = [
      { name: 'tenantUserId', def: { type: DataTypes.UUID, allowNull: true } },
      { name: 'siteTours', def: { type: DataTypes.JSON, allowNull: true, defaultValue: [] } },
      { name: 'tasks', def: { type: DataTypes.JSON, allowNull: true, defaultValue: [] } },
      { name: 'postOrders', def: { type: DataTypes.JSON, allowNull: true, defaultValue: [] } },
      { name: 'checklists', def: { type: DataTypes.JSON, allowNull: true, defaultValue: [] } },
      { name: 'skillSet', def: { type: DataTypes.JSON, allowNull: true, defaultValue: [] } },
      { name: 'department', def: { type: DataTypes.STRING(255), allowNull: true } },
    ];

    for (const col of columnsToAdd) {
      const [colResult] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'shifts' AND COLUMN_NAME = '${col.name}' AND TABLE_SCHEMA = DATABASE()`
      );

      if ((colResult as any[]).length === 0) {
        console.log(`Adding column: ${col.name}`);
        await queryInterface.addColumn('shifts', col.name, col.def as any);
      } else {
        console.log(`Column ${col.name} already exists, skipping.`);
      }
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
