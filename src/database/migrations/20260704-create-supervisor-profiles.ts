/**
 * Create the `supervisorProfiles` table — the HR/identity record for security
 * supervisors (the supervisor mirror of `securityGuard`). Keyed on the user.
 *
 * Idempotent: skips creation if the table already exists.
 *
 * Run: npx ts-node src/database/migrations/20260704-create-supervisor-profiles.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

const TABLE = 'supervisorProfiles';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  let exists = false;
  try {
    await qi.describeTable(TABLE);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    console.log(`Table ${TABLE} already exists, skipping.`);
    process.exit(0);
  }

  await qi.createTable(TABLE, {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    supervisorUserId: { type: DataTypes.UUID, allowNull: false },
    fullName: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
    governmentId: { type: DataTypes.STRING(50), allowNull: true },
    gender: { type: DataTypes.TEXT, allowNull: true },
    bloodType: { type: DataTypes.TEXT, allowNull: true },
    birthDate: { type: DataTypes.DATEONLY, allowNull: true },
    birthPlace: { type: DataTypes.STRING(120), allowNull: true },
    maritalStatus: { type: DataTypes.TEXT, allowNull: true },
    academicInstruction: { type: DataTypes.TEXT, allowNull: true },
    address: { type: DataTypes.STRING(200), allowNull: true },
    latitude: { type: DataTypes.DOUBLE, allowNull: true },
    longitude: { type: DataTypes.DOUBLE, allowNull: true },
    hiringContractDate: { type: DataTypes.DATEONLY, allowNull: true },
    guardCredentials: { type: DataTypes.STRING(255), allowNull: true },
    availability: { type: DataTypes.JSON, allowNull: true },
    languages: { type: DataTypes.JSON, allowNull: false },
    skills: { type: DataTypes.JSON, allowNull: false },
    isOnDuty: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    zone: { type: DataTypes.STRING(120), allowNull: true },
    assignedVehicle: { type: DataTypes.STRING(120), allowNull: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await qi.addIndex(TABLE, ['tenantId']);
  await qi.addIndex(TABLE, ['tenantId', 'supervisorUserId'], {
    unique: true,
    name: 'uniq_supervisor_profile_user',
    where: { deletedAt: null } as any,
  });

  console.log(`Created table ${TABLE}.`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
