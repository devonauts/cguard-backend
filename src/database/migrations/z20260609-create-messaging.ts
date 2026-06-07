require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Internal messaging (CRM ↔ worker, CRM → client) staging tables:
 *   messageConversations  — one admin↔recipient thread
 *   messages              — individual messages (wide TEXT body)
 *   messageReceipts       — per-recipient delivery/read receipts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const exists = async (t: string) => { try { await qi.describeTable(t); return true; } catch { return false; } };
  const tenantFk = {
    type: DataTypes.UUID, allowNull: false,
    references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
  };
  const stamps = {
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  };

  try {
    if (!(await exists('messageConversations'))) {
      console.log('Creating messageConversations...');
      await qi.createTable('messageConversations', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'direct' },
        recipientType: { type: DataTypes.STRING(20), allowNull: false },
        recipientUserId: { type: DataTypes.UUID, allowNull: true },
        recipientSecurityGuardId: { type: DataTypes.UUID, allowNull: true },
        recipientClientAccountId: { type: DataTypes.UUID, allowNull: true },
        subject: { type: DataTypes.STRING(200), allowNull: true },
        isOneWay: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        lastMessageAt: { type: DataTypes.DATE, allowNull: true },
        lastMessagePreview: { type: DataTypes.STRING(200), allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        tenantId: tenantFk,
        ...stamps,
      });
      await qi.addIndex('messageConversations', ['tenantId', 'recipientUserId']);
      await qi.addIndex('messageConversations', ['tenantId', 'lastMessageAt']);
      console.log('✅ messageConversations created');
    } else { console.log('messageConversations exists, skipping'); }

    if (!(await exists('messages'))) {
      console.log('Creating messages...');
      await qi.createTable('messages', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        conversationId: { type: DataTypes.UUID, allowNull: false },
        senderUserId: { type: DataTypes.UUID, allowNull: false },
        senderType: { type: DataTypes.STRING(20), allowNull: false },
        body: { type: DataTypes.TEXT, allowNull: false },
        clientMsgId: { type: DataTypes.STRING(64), allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        tenantId: tenantFk,
        ...stamps,
      });
      await qi.addIndex('messages', ['tenantId', 'conversationId', 'createdAt']);
      // Idempotency: one message per (tenant, sender, clientMsgId).
      await qi.addIndex('messages', ['tenantId', 'senderUserId', 'clientMsgId'], {
        unique: true, name: 'uniq_message_clientmsgid', where: { clientMsgId: { [require('sequelize').Op.ne]: null } } as any,
      });
      console.log('✅ messages created');
    } else { console.log('messages exists, skipping'); }

    if (!(await exists('messageReceipts'))) {
      console.log('Creating messageReceipts...');
      await qi.createTable('messageReceipts', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        messageId: { type: DataTypes.UUID, allowNull: false },
        conversationId: { type: DataTypes.UUID, allowNull: false },
        recipientUserId: { type: DataTypes.UUID, allowNull: false },
        deliveryStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
        deliveredAt: { type: DataTypes.DATE, allowNull: true },
        readAt: { type: DataTypes.DATE, allowNull: true },
        tenantId: tenantFk,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('messageReceipts', ['tenantId', 'recipientUserId', 'deliveryStatus']);
      await qi.addIndex('messageReceipts', ['tenantId', 'conversationId', 'recipientUserId']);
      await qi.addIndex('messageReceipts', ['messageId']);
      console.log('✅ messageReceipts created');
    } else { console.log('messageReceipts exists, skipping'); }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
