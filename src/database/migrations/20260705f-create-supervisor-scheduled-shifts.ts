/**
 * Create `supervisorScheduledShifts` — the generated (planned) supervisor
 * schedule from the puesto rotation engine. Idempotent. Correct camelCase name.
 *
 * Run: npx ts-node src/database/migrations/20260705f-create-supervisor-scheduled-shifts.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  try {
    await qi.describeTable('supervisorScheduledShifts');
    console.log('supervisorScheduledShifts already exists, skipping');
    process.exit(0);
  } catch { /* create */ }

  await qi.createTable('supervisorScheduledShifts', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    supervisorUserId: { type: DataTypes.UUID, allowNull: false },
    positionId: { type: DataTypes.UUID, allowNull: false },
    assignmentId: { type: DataTypes.UUID, allowNull: false },
    startTime: { type: DataTypes.DATE, allowNull: false },
    endTime: { type: DataTypes.DATE, allowNull: false },
    shiftKind: { type: DataTypes.STRING(16), allowNull: false },
    tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
    createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex('supervisorScheduledShifts', ['tenantId', 'supervisorUserId']);
  await qi.addIndex('supervisorScheduledShifts', ['positionId']);
  await qi.addIndex('supervisorScheduledShifts', ['assignmentId']);
  await qi.addIndex('supervisorScheduledShifts', ['tenantId', 'supervisorUserId', 'startTime', 'endTime'], { unique: true, name: 'sss_unique_slot' });
  console.log('Created supervisorScheduledShifts');
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
