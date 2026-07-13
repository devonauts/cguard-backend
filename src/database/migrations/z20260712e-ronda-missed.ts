/**
 * Missed-ronda detection (Configuración › Rondas): adds
 * tourAssignments.missedNotifiedAt (alert dedupe for rondaMissedService).
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712e-ronda-missed.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const ta: any = await qi.describeTable('tourAssignments');
  if (!ta.missedNotifiedAt) {
    await qi.addColumn('tourAssignments', 'missedNotifiedAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    console.log('✅ tourAssignments.missedNotifiedAt added');
  } else {
    console.log('↷ tourAssignments.missedNotifiedAt already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
