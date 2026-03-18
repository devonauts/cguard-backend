require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: ensure landline exists on tenant(s)');

    const tablesToCheck = ['tenants', 'tenant'];

    for (const tbl of tablesToCheck) {
      const [[tableExists]] = await sequelize.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${tbl}' AND TABLE_SCHEMA = DATABASE()`
      );

      if (!tableExists) {
        console.log(`Table ${tbl} does not exist, skipping.`);
        continue;
      }

      const [colResult] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tbl}' AND COLUMN_NAME = 'landline' AND TABLE_SCHEMA = DATABASE()`
      );

      if ((colResult as any[]).length === 0) {
        console.log(`Adding column: landline to table ${tbl}`);
        await queryInterface.addColumn(tbl, 'landline', {
          type: DataTypes.STRING(50),
          allowNull: true,
          defaultValue: null,
        });
        console.log(`Column landline added to ${tbl}.`);
      } else {
        console.log(`Column landline already exists on ${tbl}, skipping.`);
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
