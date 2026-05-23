require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create reporting tables...');

    const [[rjExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'reportJobs' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rjExists) {
      await queryInterface.createTable('reportJobs', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        type: { type: DataTypes.STRING(50), allowNull: true },
        params: { type: DataTypes.JSON, allowNull: true },
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
        resultUrl: { type: DataTypes.TEXT, allowNull: true },
        startedAt: { type: DataTypes.DATE, allowNull: true },
        finishedAt: { type: DataTypes.DATE, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: true, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table reportJobs created.');
    } else {
      console.log('Table reportJobs already exists.');
    }

    const [[rsExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'reportSchedules' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rsExists) {
      await queryInterface.createTable('reportSchedules', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(150), allowNull: true },
        cron: { type: DataTypes.STRING(120), allowNull: true },
        params: { type: DataTypes.JSON, allowNull: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        nextRunAt: { type: DataTypes.DATE, allowNull: true },
        lastRunAt: { type: DataTypes.DATE, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: true, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table reportSchedules created.');
    } else {
      console.log('Table reportSchedules already exists.');
    }

    const [[rtExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'reportTemplates' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rtExists) {
      await queryInterface.createTable('reportTemplates', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(150), allowNull: false },
        description: { type: DataTypes.STRING(255), allowNull: true },
        content: { type: DataTypes.JSON, allowNull: true },
        isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        tenantId: { type: DataTypes.UUID, allowNull: true, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table reportTemplates created.');
    } else {
      console.log('Table reportTemplates already exists.');
    }

    const [[rfExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'reportFavorites' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rfExists) {
      await queryInterface.createTable('reportFavorites', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(150), allowNull: true },
        params: { type: DataTypes.JSON, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: true, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table reportFavorites created.');
    } else {
      console.log('Table reportFavorites already exists.');
    }

    const [[rcExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'reportConfigs' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!rcExists) {
      await queryInterface.createTable('reportConfigs', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        defaultFormat: { type: DataTypes.STRING(50), allowNull: true },
        options: { type: DataTypes.JSON, allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: true, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table reportConfigs created.');
    } else {
      console.log('Table reportConfigs already exists.');
    }

    console.log('✅ Reporting migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Reporting migration failed:', error);
    process.exit(1);
  }
}

migrate();
