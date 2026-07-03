/**
 * Adds `assignedToUserId` to incidents so a supervisor can assign/reassign an
 * incident to a team member (distinct from the reporter `guardNameId`). The
 * activity timeline + notes reuse the existing `comments` JSON column (no schema
 * change). Idempotent.
 * Run: npx ts-node src/database/migrations/z20260703c-add-incident-assigned.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const describe = await qi.describeTable('incidents');

  if ('assignedToUserId' in describe) {
    console.log('incidents.assignedToUserId already exists, skipping');
    process.exit(0);
  }
  await qi.addColumn('incidents', 'assignedToUserId', { type: DataTypes.UUID, allowNull: true });
  console.log('Added incidents.assignedToUserId');
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
