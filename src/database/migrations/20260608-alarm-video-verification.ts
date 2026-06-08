/**
 * Phase 3: video verification — link a videoClip to the alarm case it verifies.
 * Adds videoClips.alarmCaseId. Idempotent.
 * Run: npx ts-node src/database/migrations/20260608-alarm-video-verification.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const desc = await qi.describeTable('videoClips');
  if (!('alarmCaseId' in desc)) {
    await qi.addColumn('videoClips', 'alarmCaseId', { type: DataTypes.UUID, allowNull: true });
    console.log('Added videoClips.alarmCaseId');
  } else {
    console.log('videoClips.alarmCaseId exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
