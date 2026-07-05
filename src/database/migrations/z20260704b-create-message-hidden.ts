/**
 * Per-user "delete conversation" table (WhatsApp-style hide). Idempotent.
 * Run: npx ts-node src/database/migrations/z20260704b-create-message-hidden.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[]).map((t: any) => (typeof t === 'string' ? t : t.tableName)).includes('messageHiddens');
  if (has) {
    console.log('messageHiddens already exists, skipping');
    process.exit(0);
    return;
  }

  await qi.createTable('messageHiddens', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    conversationId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    hiddenAt: { type: DataTypes.DATE, allowNull: false },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'tenants', key: 'id' },
      onDelete: 'CASCADE',
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.addIndex('messageHiddens', ['tenantId', 'userId']);
  await qi.addIndex('messageHiddens', ['tenantId', 'conversationId']);
  await qi.addIndex('messageHiddens', ['tenantId', 'userId', 'conversationId']);

  console.log('Created messageHiddens');
  process.exit(0);
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
