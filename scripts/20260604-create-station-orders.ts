/**
 * Create the stationOrders table (station-specific recurring "consignas").
 * Run: npx ts-node scripts/20260604-create-station-orders.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes, QueryTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const exists = (tables as string[]).some((t) => /^stationorders?$/i.test(t));
  if (exists) {
    console.log('stationOrders already exists, skipping');
    process.exit(0);
  }

  await qi.createTable('stationOrders', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    time: { type: DataTypes.STRING(5), allowNull: true },
    recurrence: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'daily' },
    days: { type: DataTypes.TEXT, allowNull: true },
    dayOfMonth: { type: DataTypes.INTEGER, allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: true },
    priority: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'media' },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    stationId: { type: DataTypes.UUID, allowNull: false },
    postSiteId: { type: DataTypes.UUID, allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await qi.addIndex('stationOrders', ['tenantId', 'stationId'], { name: 'station_orders_tenant_station' });

  console.log('✅ stationOrders table created');
  process.exit(0);
}

migrate().catch((err) => { console.error(err); process.exit(1); });
