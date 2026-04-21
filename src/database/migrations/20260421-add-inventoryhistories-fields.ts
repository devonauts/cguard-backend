require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add fields to inventoryhistories (patrolId, stationId, snapshot, photos)');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'inventoryhistories' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table inventoryhistories does not exist. Skipping.');
      process.exit(0);
    }

    // patrolId
    const [patrolCol] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventoryhistories' AND COLUMN_NAME = 'patrolId' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((patrolCol as any[]).length === 0) {
      console.log('Adding column patrolId to inventoryhistories');
      await queryInterface.addColumn('inventoryhistories', 'patrolId', {
        type: DataTypes.UUID,
        allowNull: true,
      } as any);
    } else {
      console.log('inventoryhistories.patrolId already exists, skipping');
    }

    // stationId
    const [stationCol] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventoryhistories' AND COLUMN_NAME = 'stationId' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((stationCol as any[]).length === 0) {
      console.log('Adding column stationId to inventoryhistories');
      await queryInterface.addColumn('inventoryhistories', 'stationId', {
        type: DataTypes.UUID,
        allowNull: true,
      } as any);
    } else {
      console.log('inventoryhistories.stationId already exists, skipping');
    }

    // snapshot (JSON)
    const [snapshotCol] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventoryhistories' AND COLUMN_NAME = 'snapshot' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((snapshotCol as any[]).length === 0) {
      console.log('Adding column snapshot (JSON) to inventoryhistories');
      await queryInterface.addColumn('inventoryhistories', 'snapshot', {
        type: DataTypes.JSON,
        allowNull: true,
      } as any);
    } else {
      console.log('inventoryhistories.snapshot already exists, skipping');
    }

    // photos (JSON array of urls/ids)
    const [photosCol] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'inventoryhistories' AND COLUMN_NAME = 'photos' AND TABLE_SCHEMA = DATABASE()`
    );
    if ((photosCol as any[]).length === 0) {
      console.log('Adding column photos (JSON) to inventoryhistories');
      await queryInterface.addColumn('inventoryhistories', 'photos', {
        type: DataTypes.JSON,
        allowNull: true,
      } as any);
    } else {
      console.log('inventoryhistories.photos already exists, skipping');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
