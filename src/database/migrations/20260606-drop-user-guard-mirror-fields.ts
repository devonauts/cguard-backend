/**
 * Drop the duplicated guard-identity mirror columns from `users`:
 *   - users.bloodType            (zero reads; owned by securityGuard.bloodType)
 *   - users.identificationNumber (owned by securityGuard.governmentId)
 *
 * Authority for guard identity is `securityGuard`. `users.fullName` is KEPT (it's
 * the login-account name). Idempotent: skips a column that's already gone.
 * Reversible: re-add the columns (STRING(10) / STRING(40), nullable) to roll back.
 *
 * Run: npx ts-node src/database/migrations/20260606-drop-user-guard-mirror-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const table = 'users';

  let desc: any = {};
  try {
    desc = await qi.describeTable(table);
  } catch (e) {
    console.error(`table ${table} not found:`, (e as Error).message);
    process.exit(1);
  }

  for (const col of ['bloodType', 'identificationNumber']) {
    if (!desc[col]) {
      console.log(`users.${col} already absent, skipping`);
      continue;
    }
    await qi.removeColumn(table, col);
    console.log(`✅ dropped users.${col}`);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
