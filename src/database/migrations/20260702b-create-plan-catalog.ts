/**
 * Create the `planCatalogs` table (editable pricing/tier catalog) and seed the
 * three built-in tiers (free / growth / enterprise).
 *
 * ROLLOUT SAFETY: every seeded tier gets the FULL feature set and an unlimited
 * seat cap, and pricing overrides are left null (→ billingModel defaults). So
 * this migration adds the mechanism WITHOUT changing any tenant's behavior — a
 * superadmin narrows tiers deliberately afterwards.
 *
 * Idempotent: skips table creation if it already exists and only seeds tiers
 * whose `key` is not already present.
 *
 * Run: npx ts-node src/database/migrations/20260702b-create-plan-catalog.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';
import { ALL_FEATURE_KEYS } from '../../lib/entitlements';

const TABLE = 'planCatalogs';

const SEED_TIERS = [
  { key: 'free', name: 'Free', description: 'Plan básico de prueba.', sortOrder: 0, isDefault: true },
  { key: 'growth', name: 'Growth', description: 'Para operaciones en crecimiento.', sortOrder: 1, isDefault: false },
  { key: 'enterprise', name: 'Enterprise', description: 'Operaciones grandes con todas las funciones.', sortOrder: 2, isDefault: false },
];

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  let exists = false;
  try {
    await qi.describeTable(TABLE);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    await qi.createTable(TABLE, {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      monthlyPerSeatCents: { type: DataTypes.INTEGER, allowNull: true },
      implementationCents: { type: DataTypes.INTEGER, allowNull: true },
      seatCap: { type: DataTypes.INTEGER, allowNull: true },
      features: { type: DataTypes.JSON, allowNull: false },
      stripePriceId: { type: DataTypes.STRING(255), allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    console.log(`Created table ${TABLE}`);
  } else {
    console.log(`Table ${TABLE} already exists, skipping create`);
  }

  // Seed built-in tiers (only those missing) with the FULL feature set +
  // unlimited caps + default pricing, so behavior is unchanged on rollout.
  const planCatalog = (models() as any).planCatalog;
  for (const tier of SEED_TIERS) {
    const found = await planCatalog.findOne({ where: { key: tier.key } });
    if (found) {
      console.log(`Tier ${tier.key} already seeded, skipping`);
      continue;
    }
    await planCatalog.create({
      key: tier.key,
      name: tier.name,
      description: tier.description,
      monthlyPerSeatCents: null,
      implementationCents: null,
      seatCap: null,
      features: ALL_FEATURE_KEYS,
      stripePriceId: null,
      active: true,
      isDefault: tier.isDefault,
      sortOrder: tier.sortOrder,
    });
    console.log(`Seeded tier ${tier.key}`);
  }

  console.log('Plan catalog migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
