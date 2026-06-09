/**
 * Adds messageReceipts.reminderSentAt — set when an "unread after 5 min" email
 * reminder has been sent for that receipt, so it is emailed at most once.
 * Idempotent. Run: npx ts-node src/database/migrations/20260609-message-reminder.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const desc = await qi.describeTable('messageReceipts');
  if (!('reminderSentAt' in desc)) {
    await qi.addColumn('messageReceipts', 'reminderSentAt', { type: DataTypes.DATE, allowNull: true });
    // Backfill existing receipts as already-reminded so the feature applies only
    // to messages sent from now on (no retroactive emails for old/unread history).
    await sequelize.query("UPDATE messageReceipts SET reminderSentAt = NOW() WHERE reminderSentAt IS NULL");
    console.log('Added messageReceipts.reminderSentAt; backfilled existing rows');
  } else {
    console.log('messageReceipts.reminderSentAt exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
