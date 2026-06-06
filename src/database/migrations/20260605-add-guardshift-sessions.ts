/**
 * Add guardShifts.sessions (JSON TEXT) — accumulates every clock in/out pair in
 * a single attendance record per shift/day (no more duplicate rows).
 * Idempotent: skips if the column already exists.
 *
 * Run: npx ts-node src/database/migrations/20260605-add-guardshift-sessions.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const table = 'guardShifts';
  let desc: any = {};
  try {
    desc = await qi.describeTable(table);
  } catch (e) {
    console.error(`table ${table} not found:`, (e as Error).message);
    process.exit(1);
  }

  if (desc.sessions) {
    console.log('guardShifts.sessions already exists, skipping');
    process.exit(0);
  }

  await qi.addColumn(table, 'sessions', {
    type: DataTypes.TEXT,
    allowNull: true,
  });

  console.log('✅ added guardShifts.sessions');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
