import { DataTypes } from 'sequelize';

/**
 * One member of a GROUP conversation (kind='group'). Direct (1:1) threads do not
 * use this table — they address the single recipient via messageConversation.
 * `source='auto'` rows are derived from the group's anchor (post site / station)
 * assignment and re-synced by groupMembershipService; `source='manual'` rows are
 * added/removed explicitly by staff and never touched by the auto-sync.
 * Uniqueness of (conversationId, userId) is enforced in code (a soft-deleted row
 * is restored rather than duplicated), because MySQL ignores partial-index where.
 */
export default function (sequelize) {
  const messageConversationParticipant = sequelize.define(
    'messageConversationParticipant',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      conversationId: { type: DataTypes.UUID, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      participantType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'guard',
        validate: { isIn: [['staff', 'guard']] },
      },
      role: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'member',
        validate: { isIn: [['admin', 'member']] },
      },
      source: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'manual',
        validate: { isIn: [['auto', 'manual']] },
      },
      securityGuardId: { type: DataTypes.UUID, allowNull: true },
      mutedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      indexes: [
        { fields: ['tenantId', 'conversationId'] },
        { fields: ['tenantId', 'userId'] },
        { fields: ['conversationId', 'userId'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  messageConversationParticipant.associate = (models) => {
    models.messageConversationParticipant.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
    models.messageConversationParticipant.belongsTo(models.messageConversation, { as: 'conversation', foreignKey: 'conversationId', constraints: false });
    models.messageConversationParticipant.belongsTo(models.user, { as: 'user', foreignKey: 'userId', constraints: false });
  };

  return messageConversationParticipant;
}
