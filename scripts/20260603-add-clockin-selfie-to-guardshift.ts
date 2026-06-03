/**
 * Add geo-stamped clock-in selfie fields to guardShifts:
 *   punchInPhoto (TEXT)      — stored selfie (privateUrl/token) taken at clock-in
 *   punchInAddress (STRING)  — reverse-geocoded address at clock-in
 *   punchInBattery (INT)     — device battery % at clock-in
 *   punchInChecklist (TEXT)  — JSON of the start-shift checklist
 *
 * Run: npx ts-node scripts/20260603-add-clockin-selfie-to-guardshift.ts
 * (kept in scripts/ so the auto-migration runner does not pick it up)
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  const tables = await queryInterface.showAllTables();
  const table =
    (tables as string[]).find((t) => /^guardshifts?$/i.test(t)) || 'guardShifts';

  const desc = await queryInterface.describeTable(table);
  const add = async (name: string, def: any) => {
    if (desc[name]) {
      console.log(`Column ${name} already exists on ${table}, skipping`);
    } else {
      await queryInterface.addColumn(table, name, def);
      console.log(`Added ${name} to ${table}`);
    }
  };

  await add('punchInPhoto', { type: DataTypes.TEXT, allowNull: true });
  await add('punchInAddress', { type: DataTypes.STRING(512), allowNull: true });
  await add('punchInBattery', { type: DataTypes.INTEGER, allowNull: true });
  await add('punchInChecklist', { type: DataTypes.TEXT, allowNull: true });

  console.log('✅ guardShift clock-in selfie migration complete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
