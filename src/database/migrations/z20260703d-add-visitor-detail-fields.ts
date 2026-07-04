/**
 * Adds the richer visitor fields the supervisor "Visitor Details" screen shows
 * (email, issuing state, visit type, host department, access level, expected
 * duration, notes, vehicle color/make-model, parking). Idempotent.
 * Run: npx ts-node src/database/migrations/z20260703d-add-visitor-detail-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const describe = await qi.describeTable('visitorLogs');

  const cols: Array<[string, any]> = [
    ['email', { type: DataTypes.STRING(255), allowNull: true }],
    ['issuingState', { type: DataTypes.STRING(120), allowNull: true }],
    ['visitType', { type: DataTypes.STRING(60), allowNull: true }],
    ['department', { type: DataTypes.STRING(120), allowNull: true }],
    ['accessLevel', { type: DataTypes.STRING(60), allowNull: true }],
    ['expectedDuration', { type: DataTypes.STRING(60), allowNull: true }],
    ['notes', { type: DataTypes.TEXT, allowNull: true }],
    ['vehicleColor', { type: DataTypes.STRING(40), allowNull: true }],
    ['vehicleMakeModel', { type: DataTypes.STRING(120), allowNull: true }],
    ['parkingLocation', { type: DataTypes.STRING(120), allowNull: true }],
  ];

  for (const [name, spec] of cols) {
    if (name in describe) {
      console.log(`visitorLogs.${name} already exists, skipping`);
      continue;
    }
    await qi.addColumn('visitorLogs', name, spec);
    console.log(`Added visitorLogs.${name}`);
  }

  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
