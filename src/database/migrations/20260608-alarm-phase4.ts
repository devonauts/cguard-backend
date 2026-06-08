/**
 * Phase 4: ECV + ASAP-to-PSAP + false-alarm reporting.
 *   alarmCallLogs           — Enhanced Call Verification attempts per case
 *   alarmPanels.psapAgency  — PSAP/agency name for the site
 *   alarmPanels.psapPhone   — PSAP/agency phone (manual dispatch fallback)
 *   alarmPanels.asapOri      — ASAP agency identifier (ORI) for automated dispatch
 *   alarmCases.ecvSatisfied — ECV completed (>=2 attempts or verified-real)
 *   alarmCases.asapRef      — reference returned by the ASAP/PSAP dispatch
 * Idempotent. Run: npx ts-node src/database/migrations/20260608-alarm-phase4.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (t: string) => (tables as any[]).map((x) => String(x).toLowerCase()).includes(t.toLowerCase());

  if (!has('alarmCallLogs')) {
    await qi.createTable('alarmCallLogs', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      alarmCaseId: { type: DataTypes.UUID, allowNull: false },
      alarmContactId: { type: DataTypes.UUID, allowNull: true },
      contactName: { type: DataTypes.STRING(160), allowNull: true },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      outcome: { type: DataTypes.STRING(20), allowNull: false }, // contacted|no_answer|verified_real|verified_false|cancel_passcode
      note: { type: DataTypes.TEXT, allowNull: true },
      actorId: { type: DataTypes.UUID, allowNull: true },
      at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex('alarmCallLogs', ['tenantId', 'alarmCaseId']);
    console.log('Created alarmCallLogs');
  } else { console.log('alarmCallLogs exists, skipping'); }

  const panel = await qi.describeTable('alarmPanels');
  for (const [col, def] of [
    ['psapAgency', { type: DataTypes.STRING(160), allowNull: true }],
    ['psapPhone', { type: DataTypes.STRING(40), allowNull: true }],
    ['asapOri', { type: DataTypes.STRING(40), allowNull: true }],
  ] as const) {
    if (!(col in panel)) { await qi.addColumn('alarmPanels', col, def as any); console.log(`Added alarmPanels.${col}`); }
  }

  const acase = await qi.describeTable('alarmCases');
  if (!('ecvSatisfied' in acase)) { await qi.addColumn('alarmCases', 'ecvSatisfied', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }); console.log('Added alarmCases.ecvSatisfied'); }
  if (!('asapRef' in acase)) { await qi.addColumn('alarmCases', 'asapRef', { type: DataTypes.STRING(80), allowNull: true }); console.log('Added alarmCases.asapRef'); }

  console.log('alarm phase4 migration complete');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
