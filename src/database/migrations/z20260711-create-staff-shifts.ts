/**
 * staffShifts — administrative/office user timesheets (web time clock), plus the
 * optional per-user office geofence columns on `users`. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260711-create-staff-shifts.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

const TABLE = 'staffShifts';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[])
    .map((t: any) => (typeof t === 'string' ? t : t.tableName))
    .includes(TABLE);

  if (!has) {
    await qi.createTable(TABLE, {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      punchInTime: { type: DataTypes.DATE, allowNull: false },
      punchInLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchInLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutTime: { type: DataTypes.DATE, allowNull: true },
      punchOutLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      observations: { type: DataTypes.TEXT, allowNull: true },
      punchInPhoto: { type: DataTypes.TEXT, allowNull: true },
      punchInAddress: { type: DataTypes.STRING(255), allowNull: true },
      punchInBattery: { type: DataTypes.INTEGER, allowNull: true },
      punchInChecklist: { type: DataTypes.TEXT, allowNull: true },
      punchOutPhoto: { type: DataTypes.TEXT, allowNull: true },
      punchOutAddress: { type: DataTypes.STRING(255), allowNull: true },
      breaks: { type: DataTypes.JSON, allowNull: true },
      hoursWorked: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      punchInDistanceM: { type: DataTypes.INTEGER, allowNull: true },
      punchOutDistanceM: { type: DataTypes.INTEGER, allowNull: true },
      punchInOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: true },
      punchOutOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'on_time' },
      lateMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      forcedClockOut: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex(TABLE, ['tenantId']);
    await qi.addIndex(TABLE, ['userId']);
    await qi.addIndex(TABLE, ['punchOutTime']);
    console.log(`Created table ${TABLE}`);
  } else {
    console.log(`${TABLE} already exists, skipping create`);
  }

  // Optional per-user office geofence (nullable → free-form punch when unset).
  const userCols: any = await qi.describeTable('users');
  const addCol = async (name: string, spec: any) => {
    if (!userCols[name]) {
      await qi.addColumn('users', name, spec);
      console.log(`Added users.${name}`);
    } else {
      console.log(`users.${name} exists, skipping`);
    }
  };
  await addCol('officeLatitude', { type: DataTypes.DECIMAL(10, 7), allowNull: true });
  await addCol('officeLongitude', { type: DataTypes.DECIMAL(10, 7), allowNull: true });
  await addCol('officeGeofenceRadiusM', { type: DataTypes.INTEGER, allowNull: true });
  await addCol('officeAddress', { type: DataTypes.STRING(255), allowNull: true });

  console.log('staffShifts migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
