require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create routes and route_points tables...');

    const [[routesExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'routes' AND TABLE_SCHEMA = DATABASE()`
    );

    if (routesExists) {
      console.log('Table routes already exists. Abort.');
    } else {
      await queryInterface.createTable('routes', {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        name: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        continuous: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        windowStart: { type: DataTypes.DATE, allowNull: true },
        windowEnd: { type: DataTypes.DATE, allowNull: true },
        days: { type: DataTypes.JSON, allowNull: true },
        assignedGuard: { type: DataTypes.UUID, allowNull: true },
        vehicleId: { type: DataTypes.UUID, allowNull: true },
        syncHitsBetweenGuards: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        forceVehicleRouteOrder: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        notifyBefore: { type: DataTypes.STRING(32), allowNull: true },
        autoCheckInByGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        forceCheckInBeforeStart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        createdById: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        updatedById: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });

      await queryInterface.addIndex('routes', ['tenantId']);
    }

    const [[pointsExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'route_points' AND TABLE_SCHEMA = DATABASE()`
    );

    if (pointsExists) {
      console.log('Table route_points already exists. Abort.');
    } else {
      await queryInterface.createTable('route_points', {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        routeId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'routes', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        siteId: { type: DataTypes.UUID, allowNull: false },
        order: { type: DataTypes.INTEGER, allowNull: false },
        duration: { type: DataTypes.INTEGER, allowNull: true },
        scheduledHits: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
        address: { type: DataTypes.TEXT, allowNull: true },
        lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
        lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      });

      await queryInterface.addIndex('route_points', ['routeId']);
      await queryInterface.addIndex('route_points', ['siteId']);
      await queryInterface.addIndex('route_points', ['routeId', 'order']);
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

migrate();
