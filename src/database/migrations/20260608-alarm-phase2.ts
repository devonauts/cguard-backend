/**
 * Phase 2: add escalation + action-plan tracking to alarmCases.
 *   stepProgress JSON  — action-plan step completion {index: {done, note, at, by}}
 *   escalatedAt  DATE  — last SLA escalation time
 *   slaLevel     INT   — escalation level (0 = none)
 * Idempotent. Run: npx ts-node src/database/migrations/20260608-alarm-phase2.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const desc = await qi.describeTable('alarmCases');

  if (!('stepProgress' in desc)) {
    await qi.addColumn('alarmCases', 'stepProgress', { type: DataTypes.JSON, allowNull: true });
    console.log('Added alarmCases.stepProgress');
  }
  if (!('escalatedAt' in desc)) {
    await qi.addColumn('alarmCases', 'escalatedAt', { type: DataTypes.DATE, allowNull: true });
    console.log('Added alarmCases.escalatedAt');
  }
  if (!('slaLevel' in desc)) {
    await qi.addColumn('alarmCases', 'slaLevel', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
    console.log('Added alarmCases.slaLevel');
  }
  console.log('alarm phase2 migration complete');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
