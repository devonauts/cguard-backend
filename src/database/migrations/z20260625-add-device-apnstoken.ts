/**
 * Direct-APNs support: store the RAW APNs device token (hex) the native Mi Seguridad
 * client app registers, separate from the FCM `pushToken`. Push resolves APNs-token
 * devices through node-apn (apnsService) instead of FCM.
 *
 *   apnsToken   raw APNs hex token for com.miseguridad devices
 *
 * Idempotent.
 * Run: npx ts-node src/database/migrations/z20260625-add-device-apnstoken.ts
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

  if (!desc['apnsToken']) {
    await qi.addColumn(table, 'apnsToken', { type: DataTypes.TEXT, allowNull: true });
    console.log(`✅ Added apnsToken to ${table}`);
  } else {
    console.log(`• apnsToken already exists on ${table}, skipping`);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
