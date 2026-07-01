/**
 * Supervisor vehicle-patrol route stops.
 *   - Creates `route_point_visits` (one row per supervisor visit to a stop:
 *     arrival/completion, checklist results, GPS + proof photos).
 *   - Adds `route_points.siteType` (station|businessInfo|client|guard|alarm)
 *     and `route_points.tasks` (per-stop checklist) if missing.
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260701-create-route-point-visit.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];

  const hasTable = tables.some((t) => /^route_point_visits$/i.test(t));
  if (!hasTable) {
    await qi.createTable('route_point_visits', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      routeId: { type: DataTypes.UUID, allowNull: false },
      routePointId: { type: DataTypes.UUID, allowNull: false },
      runId: { type: DataTypes.UUID, allowNull: true },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'pending' },
      arrivedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      taskResults: { type: DataTypes.JSON, allowNull: true },
      latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    console.log('✅ Created table route_point_visits');
    try {
      await qi.addIndex('route_point_visits', ['tenantId', 'routeId', 'status'], {
        name: 'rpv_tenant_route_status_idx',
      });
      await qi.addIndex('route_point_visits', ['tenantId', 'supervisorUserId', 'createdAt'], {
        name: 'rpv_tenant_supervisor_created_idx',
      });
      await qi.addIndex('route_point_visits', ['runId'], { name: 'rpv_run_idx' });
      console.log('✅ Added route_point_visits indexes');
    } catch (e: any) {
      console.log('• route_point_visits indexes skipped:', e?.message || e);
    }
  } else {
    console.log('• route_point_visits already exists, skipping');
  }

  // route_points.siteType + route_points.tasks
  const routePointsTable = tables.find((t) => /^route_points$/i.test(t)) || 'route_points';
  try {
    const desc = await qi.describeTable(routePointsTable);
    if (!desc['siteType']) {
      await qi.addColumn(routePointsTable, 'siteType', {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: 'station',
      });
      console.log(`✅ Added siteType to ${routePointsTable}`);
    } else {
      console.log(`• siteType already exists on ${routePointsTable}, skipping`);
    }
    if (!desc['tasks']) {
      await qi.addColumn(routePointsTable, 'tasks', { type: DataTypes.JSON, allowNull: true });
      console.log(`✅ Added tasks to ${routePointsTable}`);
    } else {
      console.log(`• tasks already exists on ${routePointsTable}, skipping`);
    }
  } catch (e: any) {
    console.log(`• route_points column add skipped:`, e?.message || e);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
