/**
 * Add per-user subscription / trial billing fields to the tenants table.
 * Existing tenants are GRANDFATHERED to billingStatus='active' so nobody is
 * locked out; only tenants created after this migration start on a trial.
 *
 * Run: npx ts-node scripts/20260604-add-tenant-billing-fields.ts
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

  const columns: Record<string, any> = {
    trialEndsAt: { type: DataTypes.DATE, allowNull: true },
    billingStatus: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'trialing' },
    stripeSubscriptionId: { type: DataTypes.STRING(255), allowNull: true },
    implementationPaidAt: { type: DataTypes.DATE, allowNull: true },
    trialReminderStage: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  };

  for (const [name, def] of Object.entries(columns)) {
    if (desc[name]) {
      console.log(`Column ${name} already exists on ${table}, skipping`);
      continue;
    }
    await qi.addColumn(table, name, def);
    console.log(`Added ${name} to ${table}`);
  }

  // Grandfather all pre-existing tenants: treat them as active paying customers,
  // and set a (historical) trialEndsAt from createdAt for reference.
  await sequelize.query(
    `UPDATE ${table}
       SET billingStatus = 'active'
     WHERE billingStatus IS NULL OR billingStatus = 'trialing'`,
  );
  await sequelize.query(
    `UPDATE ${table}
       SET trialEndsAt = DATE_ADD(createdAt, INTERVAL 14 DAY)
     WHERE trialEndsAt IS NULL`,
  );

  console.log('✅ tenant billing fields migration complete (existing tenants grandfathered to active)');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
