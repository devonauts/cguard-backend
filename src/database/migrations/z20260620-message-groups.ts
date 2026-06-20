require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Group chats for internal messaging.
 *   - messageConversations gains an "anchor" (postSite/station) + sync stamp so a
 *     group's guard membership can be re-derived from assignments.
 *   - messageConversationParticipants — one row per group member (staff or guard).
 *
 * Membership uniqueness is enforced in code (group membership service), not via a
 * partial unique index, because MySQL ignores index `where` clauses — a plain
 * unique (conversationId,userId) would block re-adding a soft-removed member.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const exists = async (t: string) => { try { await qi.describeTable(t); return true; } catch { return false; } };
  const hasCol = async (t: string, c: string) => { try { const d: any = await qi.describeTable(t); return !!d[c]; } catch { return false; } };
  const tenantFk = {
    type: DataTypes.UUID, allowNull: false,
    references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
  };

  try {
    // 1) Anchor columns on messageConversations.
    if (await exists('messageConversations')) {
      if (!(await hasCol('messageConversations', 'anchorType'))) {
        await qi.addColumn('messageConversations', 'anchorType', { type: DataTypes.STRING(20), allowNull: true });
        console.log('✅ messageConversations.anchorType added');
      }
      if (!(await hasCol('messageConversations', 'anchorId'))) {
        await qi.addColumn('messageConversations', 'anchorId', { type: DataTypes.UUID, allowNull: true });
        console.log('✅ messageConversations.anchorId added');
      }
      if (!(await hasCol('messageConversations', 'groupSyncedAt'))) {
        await qi.addColumn('messageConversations', 'groupSyncedAt', { type: DataTypes.DATE, allowNull: true });
        console.log('✅ messageConversations.groupSyncedAt added');
      }
      if (!(await hasCol('messageConversations', 'avatarUrl'))) {
        await qi.addColumn('messageConversations', 'avatarUrl', { type: DataTypes.STRING(1024), allowNull: true });
        console.log('✅ messageConversations.avatarUrl added');
      }
    } else { console.log('messageConversations missing — run create-messaging first'); }

    // 2) Participants table.
    if (!(await exists('messageConversationParticipants'))) {
      console.log('Creating messageConversationParticipants...');
      await qi.createTable('messageConversationParticipants', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        conversationId: { type: DataTypes.UUID, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false },
        participantType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'guard' }, // staff | guard
        role: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'member' },           // admin | member
        source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },         // auto | manual
        securityGuardId: { type: DataTypes.UUID, allowNull: true },
        mutedAt: { type: DataTypes.DATE, allowNull: true },
        tenantId: tenantFk,
        createdById: { type: DataTypes.UUID, allowNull: true },
        updatedById: { type: DataTypes.UUID, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      await qi.addIndex('messageConversationParticipants', ['tenantId', 'conversationId']);
      await qi.addIndex('messageConversationParticipants', ['tenantId', 'userId']);
      await qi.addIndex('messageConversationParticipants', ['conversationId', 'userId']);
      console.log('✅ messageConversationParticipants created');
    } else { console.log('messageConversationParticipants exists, skipping'); }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
