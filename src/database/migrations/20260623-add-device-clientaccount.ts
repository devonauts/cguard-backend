/**
 * Bulletproof customer push: link a registered device directly to the clientAccount
 * that registered it, so push resolves by clientAccountId and never depends on
 * clientAccount.userId being set.
 *
 *   clientAccountId   the client account whose app registered this device token
 *
 * Idempotent.
 * Run: npx ts-node src/database/migrations/20260623-add-device-clientaccount.ts
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

  if (!desc['clientAccountId']) {
    await qi.addColumn(table, 'clientAccountId', { type: DataTypes.UUID, allowNull: true });
    console.log(`✅ Added clientAccountId to ${table}`);
  } else {
    console.log(`• clientAccountId already exists on ${table}, skipping`);
  }

  // Index for the client-account push lookup.
  try {
    await qi.addIndex(table, ['tenantId', 'clientAccountId'], {
      name: 'device_tenant_clientaccount_idx',
    });
    console.log('✅ Added index device_tenant_clientaccount_idx');
  } catch (e: any) {
    console.log('• index device_tenant_clientaccount_idx skipped:', e?.message || e);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
