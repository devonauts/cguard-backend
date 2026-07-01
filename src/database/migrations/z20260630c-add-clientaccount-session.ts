/**
 * Single-device client-app login: add `clientAccounts.activeSessionId`.
 * On each customer sign-in a new session id is minted, stored here, and embedded in the
 * JWT (`sid`). authMiddleware rejects (401) any customer token whose sid != this value,
 * so a new login logs the previous device out. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260630c-add-clientaccount-session.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const desc: any = await qi.describeTable('clientAccounts');
  if (!desc.activeSessionId) {
    await qi.addColumn('clientAccounts', 'activeSessionId', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });
    console.log('✅ clientAccounts.activeSessionId added');
  } else {
    console.log('↷ clientAccounts.activeSessionId already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
