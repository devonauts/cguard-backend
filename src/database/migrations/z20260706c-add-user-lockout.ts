/**
 * users.failedLoginCount + users.lockedUntil — brute-force lockout. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260706c-add-user-lockout.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const table = await qi.describeTable('users');

  if (!table.failedLoginCount) {
    await qi.addColumn('users', 'failedLoginCount', {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
    });
    console.log('Added users.failedLoginCount');
  } else {
    console.log('users.failedLoginCount already exists, skipping');
  }

  if (!table.lockedUntil) {
    await qi.addColumn('users', 'lockedUntil', { type: DataTypes.DATE, allowNull: true });
    console.log('Added users.lockedUntil');
  } else {
    console.log('users.lockedUntil already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
