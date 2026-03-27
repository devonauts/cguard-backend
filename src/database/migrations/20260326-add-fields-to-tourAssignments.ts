require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add fields to tourAssignments...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tourAssignments' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table tourAssignments does not exist — creating table.');
      await queryInterface.createTable('tourAssignments', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        startAt: { type: DataTypes.DATE, allowNull: true },
        endAt: { type: DataTypes.DATE, allowNull: true },
        status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'assigned' },
        siteTourId: { type: DataTypes.UUID, allowNull: true },
        securityGuardId: { type: DataTypes.UUID, allowNull: true },
        postSiteId: { type: DataTypes.UUID, allowNull: true },
        stationId: { type: DataTypes.UUID, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        createdById: { type: DataTypes.UUID, allowNull: true },
        updatedById: { type: DataTypes.UUID, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });

      await queryInterface.addIndex('tourAssignments', ['tenantId'], { name: 'idx_tourAssignments_tenantId' });
      await queryInterface.addIndex('tourAssignments', ['siteTourId'], { name: 'idx_tourAssignments_siteTourId' });
      await queryInterface.addIndex('tourAssignments', ['securityGuardId'], { name: 'idx_tourAssignments_securityGuardId' });

      // add index for stationId for faster lookups by station
      try {
        await queryInterface.addIndex('tourAssignments', ['stationId'], { name: 'idx_tourAssignments_stationId' });
      } catch (e) {
        // ignore duplicate index errors
      }

      console.log('Created tourAssignments with fields and indexes.');
      process.exit(0);
    }

    // Table exists: add missing columns defensively
    const checkColumn = async (colName: string, def: any) => {
      const [col] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tourAssignments' AND COLUMN_NAME = '${colName}' AND TABLE_SCHEMA = DATABASE()`
      );
      if ((col as any[]).length === 0) {
        console.log(`Adding column ${colName} to tourAssignments`);
        await queryInterface.addColumn('tourAssignments', colName, def);
      } else {
        console.log(`Column ${colName} already exists, skipping`);
      }
    };

    await checkColumn('siteTourId', { type: DataTypes.UUID, allowNull: true });
    await checkColumn('securityGuardId', { type: DataTypes.UUID, allowNull: true });
    await checkColumn('postSiteId', { type: DataTypes.UUID, allowNull: true });
    await checkColumn('stationId', { type: DataTypes.UUID, allowNull: true });
    await checkColumn('tenantId', { type: DataTypes.UUID, allowNull: true });
    await checkColumn('createdById', { type: DataTypes.UUID, allowNull: true });
    await checkColumn('updatedById', { type: DataTypes.UUID, allowNull: true });

    // add indexes if missing
    const addIdx = async (idxName: string, fields: string[]) => {
      try {
        await queryInterface.addIndex('tourAssignments', fields, { name: idxName });
      } catch (e) {
        // ignore duplicate index errors
      }
    };

    await addIdx('idx_tourAssignments_tenantId', ['tenantId']);
    await addIdx('idx_tourAssignments_siteTourId', ['siteTourId']);
    await addIdx('idx_tourAssignments_securityGuardId', ['securityGuardId']);
    await addIdx('idx_tourAssignments_stationId', ['stationId']);

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
