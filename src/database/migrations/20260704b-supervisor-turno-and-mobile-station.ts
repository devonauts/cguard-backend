/**
 * Phase 2 additive columns:
 *  - stations.isMobile (mobile-station concept; additive, default false)
 *  - supervisorProfiles: turnoDays/turnoStart/turnoEnd/mobileStationId (turno config)
 *  - supervisorShifts: scheduledStart/scheduledEnd/shiftKind/status/lateMinutes/
 *    forcedClockOut (turno enforcement on the supervisor clock)
 *
 * All additive + nullable/defaulted → no impact on existing rows or the guard
 * clock-in/geofence path. Idempotent: each column guarded by describeTable.
 *
 * Run: npx ts-node src/database/migrations/20260704b-supervisor-turno-and-mobile-station.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function addIfMissing(qi: QueryInterface, table: string, col: string, spec: any) {
  let desc: any = {};
  try { desc = await qi.describeTable(table); } catch { return; } // table absent → skip
  if (col in desc) { console.log(`${table}.${col} exists, skipping`); return; }
  await qi.addColumn(table, col, spec);
  console.log(`Added ${table}.${col}`);
}

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  await addIfMissing(qi, 'stations', 'isMobile', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

  await addIfMissing(qi, 'supervisorProfiles', 'turnoDays', { type: DataTypes.JSON, allowNull: true });
  await addIfMissing(qi, 'supervisorProfiles', 'turnoStart', { type: DataTypes.STRING(5), allowNull: true });
  await addIfMissing(qi, 'supervisorProfiles', 'turnoEnd', { type: DataTypes.STRING(5), allowNull: true });
  await addIfMissing(qi, 'supervisorProfiles', 'mobileStationId', { type: DataTypes.UUID, allowNull: true });

  await addIfMissing(qi, 'supervisorShifts', 'scheduledStart', { type: DataTypes.DATE, allowNull: true });
  await addIfMissing(qi, 'supervisorShifts', 'scheduledEnd', { type: DataTypes.DATE, allowNull: true });
  await addIfMissing(qi, 'supervisorShifts', 'shiftKind', { type: DataTypes.STRING(16), allowNull: true });
  await addIfMissing(qi, 'supervisorShifts', 'status', { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'on_time' });
  await addIfMissing(qi, 'supervisorShifts', 'lateMinutes', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await addIfMissing(qi, 'supervisorShifts', 'forcedClockOut', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

  console.log('Supervisor turno + mobile-station migration complete.');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
