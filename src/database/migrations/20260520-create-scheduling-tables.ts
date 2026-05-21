require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create scheduling tables...');

    // 1. rotationStyles
    const [[rotExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'rotationStyles' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rotExists) {
      await queryInterface.createTable('rotationStyles', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(100), allowNull: false },
        description: { type: DataTypes.STRING(255), allowNull: true },
        dayShifts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
        nightShifts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        restDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
        isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        tenantId: { type: DataTypes.UUID, allowNull: true, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table rotationStyles created.');
    } else {
      console.log('Table rotationStyles already exists.');
    }

    // 2. stationPositions
    const [[posExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'stationPositions' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!posExists) {
      await queryInterface.createTable('stationPositions', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(100), allowNull: false },
        type: { type: DataTypes.ENUM('day', 'night', 'relief'), allowNull: false, defaultValue: 'day' },
        startTime: { type: DataTypes.STRING(5), allowNull: false },
        endTime: { type: DataTypes.STRING(5), allowNull: false },
        guardsNeeded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        stationId: { type: DataTypes.UUID, allowNull: false, references: { model: 'stations', key: 'id' } },
        tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table stationPositions created.');
    } else {
      console.log('Table stationPositions already exists.');
    }

    // 3. guardAssignments
    const [[gaExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'guardAssignments' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!gaExists) {
      await queryInterface.createTable('guardAssignments', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        guardId: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
        stationId: { type: DataTypes.UUID, allowNull: false, references: { model: 'stations', key: 'id' } },
        positionId: { type: DataTypes.UUID, allowNull: false, references: { model: 'stationPositions', key: 'id' } },
        rotationStyleId: { type: DataTypes.UUID, allowNull: false, references: { model: 'rotationStyles', key: 'id' } },
        startDate: { type: DataTypes.DATEONLY, allowNull: false },
        endDate: { type: DataTypes.DATEONLY, allowNull: true },
        platoonOffset: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        isRelief: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        status: { type: DataTypes.ENUM('active', 'paused', 'ended'), allowNull: false, defaultValue: 'active' },
        tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });

      await queryInterface.addIndex('guardAssignments', ['guardId', 'stationId']);
      await queryInterface.addIndex('guardAssignments', ['positionId']);
      await queryInterface.addIndex('guardAssignments', ['status']);
      console.log('Table guardAssignments created.');
    } else {
      console.log('Table guardAssignments already exists.');
    }

    // 4. Add rotationStyleId to stations table
    const [[rotCol]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'stations' AND COLUMN_NAME = 'rotationStyleId' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rotCol) {
      await queryInterface.addColumn('stations', 'rotationStyleId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'rotationStyles', key: 'id' },
      });
      console.log('Added rotationStyleId to stations.');
    }

    // 5. Add scheduleType to stations
    const [[stCol]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'stations' AND COLUMN_NAME = 'scheduleType' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!stCol) {
      await queryInterface.addColumn('stations', 'scheduleType', {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '12h-day, 12h-night, 24h, custom',
      });
      console.log('Added scheduleType to stations.');
    }

    // 6. Add positionId and guardAssignmentId to shifts for tracing
    const [[posCol]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'shifts' AND COLUMN_NAME = 'positionId' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!posCol) {
      await queryInterface.addColumn('shifts', 'positionId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'stationPositions', key: 'id' },
      });
      console.log('Added positionId to shifts.');
    }

    const [[gaCol]] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'shifts' AND COLUMN_NAME = 'guardAssignmentId' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!gaCol) {
      await queryInterface.addColumn('shifts', 'guardAssignmentId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'guardAssignments', key: 'id' },
      });
      console.log('Added guardAssignmentId to shifts.');
    }

    // 7. Seed system rotation presets (tenant=null)
    const [existing] = await sequelize.query(`SELECT COUNT(*) as cnt FROM rotationStyles WHERE isSystem = 1`);
    if (!existing[0] || existing[0].cnt === 0) {
      const now = new Date();
      await queryInterface.bulkInsert('rotationStyles', [
        { id: '00000000-0000-4000-a000-000000000001', name: '5-2', description: '5 días trabajo, 2 descanso', dayShifts: 5, nightShifts: 0, restDays: 2, isSystem: true, tenantId: null, createdById: null, updatedById: null, createdAt: now, updatedAt: now, deletedAt: null },
        { id: '00000000-0000-4000-a000-000000000002', name: '6-1', description: '6 días trabajo, 1 descanso', dayShifts: 6, nightShifts: 0, restDays: 1, isSystem: true, tenantId: null, createdById: null, updatedById: null, createdAt: now, updatedAt: now, deletedAt: null },
        { id: '00000000-0000-4000-a000-000000000003', name: '4-2', description: '4 días trabajo, 2 descanso', dayShifts: 4, nightShifts: 0, restDays: 2, isSystem: true, tenantId: null, createdById: null, updatedById: null, createdAt: now, updatedAt: now, deletedAt: null },
        { id: '00000000-0000-4000-a000-000000000004', name: '3-3-2', description: '3 días, 3 noches, 2 descanso', dayShifts: 3, nightShifts: 3, restDays: 2, isSystem: true, tenantId: null, createdById: null, updatedById: null, createdAt: now, updatedAt: now, deletedAt: null },
        { id: '00000000-0000-4000-a000-000000000005', name: '4-4-2', description: '4 días, 4 noches, 2 descanso', dayShifts: 4, nightShifts: 4, restDays: 2, isSystem: true, tenantId: null, createdById: null, updatedById: null, createdAt: now, updatedAt: now, deletedAt: null },
        { id: '00000000-0000-4000-a000-000000000006', name: '2-2-2', description: '2 días, 2 noches, 2 descanso', dayShifts: 2, nightShifts: 2, restDays: 2, isSystem: true, tenantId: null, createdById: null, updatedById: null, createdAt: now, updatedAt: now, deletedAt: null },
      ]);
      console.log('Seeded system rotation styles.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
