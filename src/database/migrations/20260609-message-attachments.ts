/**
 * Adds messages.attachments (JSON) — image/video attachments on a message:
 * [{ url, type: 'image'|'video', name, sizeInBytes }]. Idempotent.
 * Run: npx ts-node src/database/migrations/20260609-message-attachments.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const desc = await qi.describeTable('messages');
  if (!('attachments' in desc)) {
    await qi.addColumn('messages', 'attachments', { type: DataTypes.JSON, allowNull: true });
    console.log('Added messages.attachments');
  } else {
    console.log('messages.attachments exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
