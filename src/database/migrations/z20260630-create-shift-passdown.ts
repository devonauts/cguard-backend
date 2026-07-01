/**
 * Shift passdown (pase de turno / relevo): a guard's handover left at clock-out and
 * received automatically by the next guard who clocks in at the post.
 *   - Creates `shiftPassdowns` (the handover record + who left/received it).
 *   - Adds `tasks.passdownId` so instruction-tasks (source='passdown') link back.
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260630-create-shift-passdown.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];

  const hasTable = tables.some((t) => /^shiftPassdowns$/i.test(t));
  if (!hasTable) {
    await qi.createTable('shiftPassdowns', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      stationId: { type: DataTypes.UUID, allowNull: false },
      stationName: { type: DataTypes.STRING(250), allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      outgoingGuardUserId: { type: DataTypes.UUID, allowNull: true },
      outgoingSecurityGuardId: { type: DataTypes.UUID, allowNull: true },
      outgoingGuardName: { type: DataTypes.STRING(200), allowNull: true },
      guardShiftId: { type: DataTypes.UUID, allowNull: true },
      shiftSchedule: { type: DataTypes.STRING(20), allowNull: true },
      shiftKind: { type: DataTypes.STRING(10), allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      instructionCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'open' },
      receivedByGuardUserId: { type: DataTypes.UUID, allowNull: true },
      receivedByName: { type: DataTypes.STRING(200), allowNull: true },
      receivedByShiftId: { type: DataTypes.UUID, allowNull: true },
      receivedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    console.log('✅ Created table shiftPassdowns');
    try {
      await qi.addIndex('shiftPassdowns', ['tenantId', 'stationId', 'status'], { name: 'passdown_tenant_station_status_idx' });
      await qi.addIndex('shiftPassdowns', ['tenantId', 'status', 'createdAt'], { name: 'passdown_tenant_status_created_idx' });
      console.log('✅ Added shiftPassdowns indexes');
    } catch (e: any) {
      console.log('• shiftPassdowns indexes skipped:', e?.message || e);
    }
  } else {
    console.log('• shiftPassdowns already exists, skipping');
  }

  // tasks.passdownId — link an instruction-task back to its passdown.
  const tasksTable = tables.find((t) => /^tasks$/i.test(t)) || 'tasks';
  const desc = await qi.describeTable(tasksTable);
  if (!desc['passdownId']) {
    await qi.addColumn(tasksTable, 'passdownId', { type: DataTypes.UUID, allowNull: true });
    console.log(`✅ Added passdownId to ${tasksTable}`);
  } else {
    console.log(`• passdownId already exists on ${tasksTable}, skipping`);
  }

  process.exit(0);
}

migrate().catch((err) => { console.error(err); process.exit(1); });
