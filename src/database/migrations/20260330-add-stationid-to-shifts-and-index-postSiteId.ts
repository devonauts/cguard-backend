require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add stationId to shifts and index on postSiteId...');

    const [[shiftsTable]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'shifts' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!shiftsTable) {
      console.log('Table shifts does not exist. Skipping.');
      process.exit(0);
    }

    const [col] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'shifts' AND COLUMN_NAME = 'stationId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((col as any[]).length === 0) {
      console.log('Adding column stationId to shifts');
      await queryInterface.addColumn('shifts', 'stationId', {
        type: DataTypes.UUID,
        allowNull: true,
      } as any);
    } else {
      console.log('shifts.stationId already exists, skipping');
    }

    // Add FK constraint if not present via raw alter (best-effort: many environments manage constraints separately)
    try {
      // Attempt to add index on tenantId + postSiteId to speed up queries filtered by tenant and post site
      const [[idxExists]] = await sequelize.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_NAME = 'shifts' AND INDEX_NAME = 'shifts_tenantId_postSiteId_idx' AND TABLE_SCHEMA = DATABASE()`
      );

      if (!(idxExists)) {
        console.log('Adding index shifts_tenantId_postSiteId_idx');
        await queryInterface.addIndex('shifts', ['tenantId', 'postSiteId'], {
          name: 'shifts_tenantId_postSiteId_idx',
        } as any);
      } else {
        console.log('Index shifts_tenantId_postSiteId_idx already exists, skipping');
      }
    } catch (e) {
      console.warn('Failed to add index shifts_tenantId_postSiteId_idx (non-fatal)', e && (e as any).message ? (e as any).message : e);
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
