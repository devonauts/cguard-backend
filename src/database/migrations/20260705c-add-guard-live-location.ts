/**
 * Add live-telemetry columns to guardShifts so the supervisor sees the guard's
 * CURRENT battery / GPS / speed while on duty (previously only the clock-in
 * snapshot was available). The worker app pings these while clocked in.
 * Additive/nullable → no impact on existing rows. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260705c-add-guard-live-location.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('guardShifts'); } catch { process.exit(0); }

  const cols: Array<[string, any]> = [
    ['liveLatitude', { type: DataTypes.DECIMAL(10, 7), allowNull: true }],
    ['liveLongitude', { type: DataTypes.DECIMAL(10, 7), allowNull: true }],
    ['liveSpeed', { type: DataTypes.FLOAT, allowNull: true }],
    ['liveHeading', { type: DataTypes.FLOAT, allowNull: true }],
    ['liveAccuracy', { type: DataTypes.FLOAT, allowNull: true }],
    ['liveBattery', { type: DataTypes.INTEGER, allowNull: true }],
    ['liveLocationAt', { type: DataTypes.DATE, allowNull: true }],
  ];

  for (const [name, def] of cols) {
    if (!(name in desc)) {
      await qi.addColumn('guardShifts', name, def);
      console.log(`Added guardShifts.${name}`);
    } else { console.log(`guardShifts.${name} exists, skipping`); }
  }

  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
