/**
 * Add stripeSeatItemId to tenants — the per-seat subscription item id used to
 * reconcile seat quantity to Stripe (mid-cycle proration).
 * Run: npx ts-node scripts/20260604-add-stripe-seat-item.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = (await qi.showAllTables()) as string[];
  const table = tables.find((t) => /^tenants?$/i.test(t)) || 'tenants';
  const desc = await qi.describeTable(table);
  if (desc['stripeSeatItemId']) {
    console.log(`Column stripeSeatItemId already exists on ${table}, skipping`);
    process.exit(0);
  }
  await qi.addColumn(table, 'stripeSeatItemId', { type: DataTypes.STRING(255), allowNull: true });
  console.log(`✅ Added stripeSeatItemId to ${table}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
