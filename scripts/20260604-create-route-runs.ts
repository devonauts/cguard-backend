/**
 * Create the routeRuns table — daily completion tracking for vehicle-patrol routes.
 * Run: npx ts-node scripts/20260604-create-route-runs.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  if ((tables as string[]).some((t) => /^routeruns?$/i.test(t))) {
    console.log('routeRuns already exists, skipping');
    process.exit(0);
  }
  await qi.createTable('routeRuns', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'completed' },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    completedByName: { type: DataTypes.STRING(255), allowNull: true },
    routeId: { type: DataTypes.UUID, allowNull: false },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    completedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await qi.addIndex('routeRuns', ['tenantId', 'routeId', 'date'], { name: 'route_runs_tenant_route_date' });
  console.log('✅ routeRuns table created');
  process.exit(0);
}
migrate().catch((e) => { console.error(e); process.exit(1); });
