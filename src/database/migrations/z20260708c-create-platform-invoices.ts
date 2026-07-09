/**
 * platformInvoices — Stripe subscription invoices charged to TENANTS for the
 * per-user plan (distinct from `invoices`, the tenant→client invoicing
 * feature). Written by the Stripe webhook + on-demand sync; unique by
 * stripeInvoiceId so re-delivery is a harmless upsert. Idempotent.
 * Run: npx ts-node src/database/migrations/z20260708c-create-platform-invoices.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

const TABLE = 'platformInvoices';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[])
    .map((t: any) => (typeof t === 'string' ? t : t.tableName))
    .includes(TABLE);
  if (has) {
    console.log(`${TABLE} already exists, skipping`);
    process.exit(0);
    return;
  }

  await qi.createTable(TABLE, {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    stripeInvoiceId: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    stripeCustomerId: { type: DataTypes.STRING(255), allowNull: true },
    stripeSubscriptionId: { type: DataTypes.STRING(255), allowNull: true },
    number: { type: DataTypes.STRING(64), allowNull: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'open' },
    amountDueCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    amountPaidCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'usd' },
    periodStart: { type: DataTypes.DATE, allowNull: true },
    periodEnd: { type: DataTypes.DATE, allowNull: true },
    hostedInvoiceUrl: { type: DataTypes.TEXT, allowNull: true },
    invoicePdfUrl: { type: DataTypes.TEXT, allowNull: true },
    linesSummary: { type: DataTypes.TEXT, allowNull: true },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    issuedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });

  await qi.addIndex(TABLE, ['tenantId']);
  await qi.addIndex(TABLE, ['stripeCustomerId']);
  await qi.addIndex(TABLE, ['status']);

  console.log(`Created table ${TABLE}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
