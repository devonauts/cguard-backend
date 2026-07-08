/**
 * supervisorShifts clock-in parity with guardShifts: add stamped selfie URL,
 * reverse-geocoded address, battery %, and the pre-shift checklist so a
 * supervisor punch carries the same evidence a guard punch does (CRM live map +
 * Actividades render the selfie). Idempotent — checks each column before adding.
 * Run: npx ts-node src/database/migrations/z20260708-supervisorshift-clockin-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const db = models();
  const qi: QueryInterface = db.sequelize.getQueryInterface();
  const table = db.supervisorShift.getTableName();
  const cols: any = await qi.describeTable(table as any);

  const add = async (name: string, spec: any) => {
    if (cols[name]) { console.log(`  ${name} exists — skip`); return; }
    await qi.addColumn(table as any, name, spec);
    console.log(`  + ${name}`);
  };

  await add('punchInPhoto', { type: DataTypes.TEXT, allowNull: true });
  await add('punchInAddress', { type: DataTypes.STRING(255), allowNull: true });
  await add('punchInBattery', { type: DataTypes.INTEGER, allowNull: true });
  await add('punchInChecklist', { type: DataTypes.TEXT, allowNull: true });
  await add('punchOutPhoto', { type: DataTypes.TEXT, allowNull: true });
  await add('punchOutAddress', { type: DataTypes.STRING(255), allowNull: true });

  console.log(`supervisorShifts clock-in fields ready on ${JSON.stringify(table)}`);
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
