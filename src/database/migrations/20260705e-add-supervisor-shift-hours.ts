/**
 * Add hoursWorked to supervisorShifts (computed at clock-out, break-adjusted) so
 * a supervisor's turno feeds nómina / asistencia the same way a guard's does.
 * Additive/nullable → no impact on existing rows. Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260705e-add-supervisor-shift-hours.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  let desc: any = {};
  try { desc = await qi.describeTable('supervisorShifts'); } catch { process.exit(0); }

  if (!('hoursWorked' in desc)) {
    await qi.addColumn('supervisorShifts', 'hoursWorked', { type: DataTypes.DECIMAL(6, 2), allowNull: true });
    console.log('Added supervisorShifts.hoursWorked');
  } else { console.log('supervisorShifts.hoursWorked exists, skipping'); }

  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
