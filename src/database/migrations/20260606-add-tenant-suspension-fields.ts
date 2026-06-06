/**
 * Add platform-admin suspension fields to tenants: `suspendedAt` + `suspensionReason`.
 * Lets a superadmin suspend/reactivate a tenant independently of Stripe billing
 * status or paranoid soft-delete. Idempotent: skips columns that already exist.
 *
 * Run: npx ts-node src/database/migrations/20260606-add-tenant-suspension-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const describe = await qi.describeTable('tenants');

  if (!('suspendedAt' in describe)) {
    await qi.addColumn('tenants', 'suspendedAt', {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    });
    console.log('Added tenants.suspendedAt');
  } else {
    console.log('tenants.suspendedAt already exists, skipping');
  }

  if (!('suspensionReason' in describe)) {
    await qi.addColumn('tenants', 'suspensionReason', {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    });
    console.log('Added tenants.suspensionReason');
  } else {
    console.log('tenants.suspensionReason already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
