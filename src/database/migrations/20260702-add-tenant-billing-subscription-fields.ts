/**
 * Add the platform billing / subscription / trial columns to `tenants`.
 *
 * These columns exist on the Sequelize tenant model and drive the whole
 * subscription + free-trial mechanism (trial auto-start, the trial scheduler,
 * the paywall middleware, Stripe activation, seat reconciliation), but no
 * migration ever created them — on the current production DB they were added
 * by an early `sync`, leaving a codebase gap where a fresh DB (staging / DR /
 * a new region) built purely from migrations would be MISSING them and the
 * app would throw at runtime.
 *
 * This migration closes that gap. It covers:
 *   Legacy Stripe-tier fields:  plan, planStatus, planStripeCustomerId, planUserId
 *   Per-seat billing / trial:   trialEndsAt, billingStatus, stripeSubscriptionId,
 *                               stripeSeatItemId, implementationPaidAt, trialReminderStage
 *
 * NOT included here (they already have their own migrations):
 *   onboardingCompleted        → 20260606-add-tenant-onboarding-completed.ts
 *   suspendedAt/suspensionReason → 20260606-add-tenant-suspension-fields.ts
 *
 * Idempotent: every column is guarded by a describeTable() check, so it is a
 * safe no-op on the existing production DB (all columns already present) and
 * only adds what is missing on a fresh DB. Defaults mirror the model exactly.
 *
 * Run: npx ts-node src/database/migrations/20260702-add-tenant-billing-subscription-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const describe = await qi.describeTable('tenants');

  const addIfMissing = async (name: string, spec: any) => {
    if (!(name in describe)) {
      await qi.addColumn('tenants', name, spec);
      console.log(`Added tenants.${name}`);
    } else {
      console.log(`tenants.${name} already exists, skipping`);
    }
  };

  // ── Legacy Stripe-tier fields ──────────────────────────────────────────────
  await addIfMissing('plan', {
    type: DataTypes.STRING(255),
    allowNull: false,
    defaultValue: 'free',
  });
  await addIfMissing('planStatus', {
    type: DataTypes.STRING(255),
    allowNull: false,
    defaultValue: 'active',
  });
  await addIfMissing('planStripeCustomerId', {
    type: DataTypes.STRING(255),
    allowNull: true,
    defaultValue: null,
  });
  await addIfMissing('planUserId', {
    type: DataTypes.UUID,
    allowNull: true,
    defaultValue: null,
  });

  // ── Per-seat subscription / trial billing ─────────────────────────────────
  await addIfMissing('trialEndsAt', {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  await addIfMissing('billingStatus', {
    // trialing | active | past_due | trial_expired | canceled
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'trialing',
  });
  await addIfMissing('stripeSubscriptionId', {
    type: DataTypes.STRING(255),
    allowNull: true,
    defaultValue: null,
  });
  await addIfMissing('stripeSeatItemId', {
    type: DataTypes.STRING(255),
    allowNull: true,
    defaultValue: null,
  });
  await addIfMissing('implementationPaidAt', {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  await addIfMissing('trialReminderStage', {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  });

  console.log('Tenant billing/subscription fields migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
