/**
 * Create supervisor-position tables (isolated supervisor rotation):
 *  - supervisorPositions           (the "puesto", e.g. Aguila2 + rotation config)
 *  - supervisorPositionAssignments (which supervisors are assigned + phase)
 * Reuses the existing `rotationStyles` table for the día/noche/rest pattern.
 * Idempotent (skips a table if it already exists). Correct camelCase names.
 *
 * Run: npx ts-node src/database/migrations/20260705e-create-supervisor-positions.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function ensureTable(qi: QueryInterface, name: string, spec: any, indexes: string[][]) {
  try {
    await qi.describeTable(name);
    console.log(`${name} already exists, skipping`);
    return;
  } catch { /* create */ }
  await qi.createTable(name, spec);
  for (const cols of indexes) await qi.addIndex(name, cols);
  console.log(`Created ${name}`);
}

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  await ensureTable(qi, 'supervisorPositions', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    zone: { type: DataTypes.STRING(120), allowNull: true },
    scheduleType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '24h' },
    rotationStyleId: { type: DataTypes.UUID, allowNull: true },
    startTime: { type: DataTypes.STRING(5), allowNull: true },
    endTime: { type: DataTypes.STRING(5), allowNull: true },
    guardsNeeded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    mobileStationId: { type: DataTypes.UUID, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
    createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  }, [['tenantId']]);

  await ensureTable(qi, 'supervisorPositionAssignments', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    supervisorUserId: { type: DataTypes.UUID, allowNull: false },
    positionId: { type: DataTypes.UUID, allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: true },
    platoonOffset: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isRelief: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' },
    tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
    createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  }, [['tenantId'], ['positionId'], ['supervisorUserId']]);

  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
