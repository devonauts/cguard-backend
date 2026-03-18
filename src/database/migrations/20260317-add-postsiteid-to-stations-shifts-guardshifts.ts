require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add postSiteId to stations, shifts, guardShifts...');

    // stations
    const [[stationsTable]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'stations' AND TABLE_SCHEMA = DATABASE()`
    );
    if (!stationsTable) {
      console.log('Table stations does not exist. Skipping stations.');
    } else {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'stations' AND COLUMN_NAME = 'postSiteId' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log('Adding column postSiteId to stations');
        await queryInterface.addColumn('stations', 'postSiteId', {
          type: DataTypes.UUID,
          allowNull: true,
        });
      } else {
        console.log('stations.postSiteId already exists, skipping');
      }
    }

    // shifts
    const [[shiftsTable]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'shifts' AND TABLE_SCHEMA = DATABASE()`
    );
    if (!shiftsTable) {
      console.log('Table shifts does not exist. Skipping shifts.');
    } else {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'shifts' AND COLUMN_NAME = 'postSiteId' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log('Adding column postSiteId to shifts');
        await queryInterface.addColumn('shifts', 'postSiteId', {
          type: DataTypes.UUID,
          allowNull: true,
        });
      } else {
        console.log('shifts.postSiteId already exists, skipping');
      }
    }

    // guardShifts
    const [[gshTable]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'guardShifts' AND TABLE_SCHEMA = DATABASE()`
    );
    if (!gshTable) {
      console.log('Table guardShifts does not exist. Skipping guardShifts.');
    } else {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'guardShifts' AND COLUMN_NAME = 'postSiteId' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log('Adding column postSiteId to guardShifts');
        await queryInterface.addColumn('guardShifts', 'postSiteId', {
          type: DataTypes.UUID,
          allowNull: true,
        });
      } else {
        console.log('guardShifts.postSiteId already exists, skipping');
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
