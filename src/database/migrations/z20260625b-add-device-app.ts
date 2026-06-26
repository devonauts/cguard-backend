/**
 * Tag each registered device with the app that owns it, so push events route to the
 * correct app:
 *   'worker'  → C-Guard Pro operaciones app (FCM)
 *   'client'  → native Mi Seguridad client app (direct APNs)
 *
 * Backfill heuristic: a device registered with a clientAccountId came from the client
 * app; everything else is the worker app. New registrations stamp `app` explicitly.
 *
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260625b-add-device-app.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const table =
    (tables as string[]).find((t) => /^deviceIdInformations$/i.test(t)) ||
    'deviceIdInformations';
  const desc = await qi.describeTable(table);

  if (!desc['app']) {
    await qi.addColumn(table, 'app', { type: DataTypes.STRING(20), allowNull: true });
    console.log(`✅ Added app to ${table}`);
  } else {
    console.log(`• app already exists on ${table}, skipping`);
  }

  await sequelize.query(
    `UPDATE ${table} SET app='client' WHERE app IS NULL AND clientAccountId IS NOT NULL`,
  );
  await sequelize.query(
    `UPDATE ${table} SET app='worker' WHERE app IS NULL AND clientAccountId IS NULL`,
  );
  console.log('✅ Backfilled app (client where clientAccountId set, else worker)');

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
