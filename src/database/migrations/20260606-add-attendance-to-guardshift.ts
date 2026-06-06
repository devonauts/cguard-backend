/**
 * Add Nómina / Time & Attendance columns to the guardShifts table. Idempotent:
 * each column is added only if missing. Existing rows get safe defaults.
 *
 * Run: npx ts-node src/database/migrations/20260606-add-attendance-to-guardshift.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const table = (tables as string[]).find((t) => /^guardshifts$/i.test(t)) || 'guardShifts';
  const desc = await qi.describeTable(table);

  const columns: Record<string, any> = {
    shiftId: { type: DataTypes.UUID, allowNull: true },
    scheduledStart: { type: DataTypes.DATE, allowNull: true },
    scheduledEnd: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'on_time' },
    hoursWorked: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    overtimeMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lateMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    earlyDepartureMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    punchInDistanceM: { type: DataTypes.INTEGER, allowNull: true },
    punchOutDistanceM: { type: DataTypes.INTEGER, allowNull: true },
    punchInOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    punchOutOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    deviceInfo: { type: DataTypes.TEXT, allowNull: true },
    punchInIp: { type: DataTypes.STRING(64), allowNull: true },
    punchOutIp: { type: DataTypes.STRING(64), allowNull: true },
    punchOutPhoto: { type: DataTypes.TEXT, allowNull: true },
    punchOutAddress: { type: DataTypes.STRING(512), allowNull: true },
    punchOutBattery: { type: DataTypes.INTEGER, allowNull: true },
    approvalStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'none' },
    approvedById: { type: DataTypes.UUID, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    approvalNotes: { type: DataTypes.TEXT, allowNull: true },
  };

  let added = 0;
  for (const [name, def] of Object.entries(columns)) {
    if (desc[name]) continue;
    await qi.addColumn(table, name, def);
    added++;
  }

  try {
    await qi.addIndex(table, ['tenantId', 'status'], { name: 'guardShifts_tenant_status' });
  } catch (e) {
    console.warn('index add skipped:', (e as Error).message);
  }

  console.log(`✅ guardShifts: added ${added} attendance column(s)`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
