require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add guardShift coordinate columns (punchIn/Out lat/lng)');

    const [[gshTable]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'guardShifts' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!gshTable) {
      console.log('Table guardShifts does not exist. Skipping migration.');
      process.exit(0);
    }

    const checkAndAdd = async (colName: string, options: any) => {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'guardShifts' AND COLUMN_NAME = '${colName}' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log(`Adding column ${colName} to guardShifts`);
        await queryInterface.addColumn('guardShifts', colName, options as any);
      } else {
        console.log(`guardShifts.${colName} already exists, skipping`);
      }
    };

    await checkAndAdd('punchInLatitude', { type: DataTypes.DOUBLE, allowNull: true });
    await checkAndAdd('punchInLongitude', { type: DataTypes.DOUBLE, allowNull: true });
    await checkAndAdd('punchOutLatitude', { type: DataTypes.DOUBLE, allowNull: true });
    await checkAndAdd('punchOutLongitude', { type: DataTypes.DOUBLE, allowNull: true });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
