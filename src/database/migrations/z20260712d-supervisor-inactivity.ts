/**
 * Extends the guard inactivity alert to supervisors on patrol:
 * supervisorShifts.inactivityAlertAt (one guard.inactive alert per silence
 * episode — guardInactivityService supervisor leg).
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712d-supervisor-inactivity.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const ss: any = await qi.describeTable('supervisorShifts');
  if (!ss.inactivityAlertAt) {
    await qi.addColumn('supervisorShifts', 'inactivityAlertAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    console.log('✅ supervisorShifts.inactivityAlertAt added');
  } else {
    console.log('↷ supervisorShifts.inactivityAlertAt already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
