/**
 * Add clientWelcomeEmailEnabled (BOOLEAN, default true) to the settings table.
 * Controls whether adding a client auto-sends the portal welcome/invitation email.
 *
 * Run: npx ts-node scripts/20260604-add-client-welcome-email-pref.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const table = (tables as string[]).find((t) => /^settings$/i.test(t)) || 'settings';

  const desc = await qi.describeTable(table);
  if (desc['clientWelcomeEmailEnabled']) {
    console.log(`Column clientWelcomeEmailEnabled already exists on ${table}, skipping`);
    process.exit(0);
  }

  await qi.addColumn(table, 'clientWelcomeEmailEnabled', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  });
  console.log(`✅ Added clientWelcomeEmailEnabled to ${table}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
