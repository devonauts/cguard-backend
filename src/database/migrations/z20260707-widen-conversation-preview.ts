/**
 * messageConversations.lastMessagePreview VARCHAR(200) → TEXT. The preview is
 * stored encrypted (enc1:… base64), longer than plaintext, and overflowed 200 →
 * "Data too long" 500 on message send. Idempotent-ish (changeColumn is safe to
 * re-run). Run: npx ts-node src/database/migrations/z20260707-widen-conversation-preview.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const db = models();
  const qi: QueryInterface = db.sequelize.getQueryInterface();
  const table = db.messageConversation.getTableName();
  await qi.changeColumn(table as any, 'lastMessagePreview', { type: DataTypes.TEXT, allowNull: true });
  console.log(`Widened ${JSON.stringify(table)}.lastMessagePreview → TEXT`);
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
