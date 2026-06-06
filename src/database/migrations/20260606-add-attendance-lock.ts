/**
 * Add payroll-lock columns (locked, lockedAt) to guardShifts. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260606-add-attendance-lock.ts
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

  let added = 0;
  if (!desc['locked']) {
    await qi.addColumn(table, 'locked', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    added++;
  }
  if (!desc['lockedAt']) {
    await qi.addColumn(table, 'lockedAt', { type: DataTypes.DATE, allowNull: true });
    added++;
  }
  console.log(`✅ guardShifts: added ${added} lock column(s)`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
