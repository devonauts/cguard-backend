import { DataTypes } from 'sequelize';

/**
 * One admin ↔ one-recipient (guard or client) messaging thread, tenant-scoped.
 * recipientUserId is the canonical addressing key (a users.id, whether the
 * recipient is a guard or a client); recipientSecurityGuardId/ClientAccountId are
 * denormalized for labels/joins. The DB is the source of truth — push/socket are
 * best-effort nudges. Dedicated tables (not the legacy notification model) so we
 * can carry threads + per-recipient read receipts.
 */
export default function (sequelize) {
  const messageConversation = sequelize.define(
    'messageConversation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'direct' }, // direct | group
      recipientType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: { isIn: [['guard', 'client']] },
      },
      recipientUserId: { type: DataTypes.UUID, allowNull: true },
      recipientSecurityGuardId: { type: DataTypes.UUID, allowNull: true },
      recipientClientAccountId: { type: DataTypes.UUID, allowNull: true },
      subject: { type: DataTypes.STRING(200), allowNull: true },
      isOneWay: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Group anchor: membership is re-derived from this post site / station's
      // guard assignments (kind='group' only). anchorType: 'postSite' | 'station'.
      anchorType: { type: DataTypes.STRING(20), allowNull: true },
      anchorId: { type: DataTypes.UUID, allowNull: true },
      groupSyncedAt: { type: DataTypes.DATE, allowNull: true },
      avatarUrl: { type: DataTypes.STRING(1024), allowNull: true },
      // Denormalized for inbox sort + preview without a join.
      lastMessageAt: { type: DataTypes.DATE, allowNull: true },
      lastMessagePreview: { type: DataTypes.STRING(200), allowNull: true },
      importHash: { type: DataTypes.STRING(255), allowNull: true, validate: { len: [0, 255] } },
    },
    {
      indexes: [
        { fields: ['tenantId', 'recipientUserId'] },
        { fields: ['tenantId', 'lastMessageAt'] },
        { unique: true, fields: ['importHash', 'tenantId'], where: { deletedAt: null } },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  messageConversation.associate = (models) => {
    models.messageConversation.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
    models.messageConversation.belongsTo(models.user, { as: 'recipientUser', foreignKey: 'recipientUserId', constraints: false });
    models.messageConversation.belongsTo(models.securityGuard, { as: 'recipientGuard', foreignKey: 'recipientSecurityGuardId', constraints: false });
    models.messageConversation.belongsTo(models.clientAccount, { as: 'recipientClient', foreignKey: 'recipientClientAccountId', constraints: false });
    models.messageConversation.belongsTo(models.user, { as: 'createdBy', foreignKey: 'createdById', constraints: false });
    models.messageConversation.hasMany(models.message, { as: 'messages', foreignKey: 'conversationId', constraints: false });
    models.messageConversation.hasMany(models.messageConversationParticipant, { as: 'participants', foreignKey: 'conversationId', constraints: false });
  };

  return messageConversation;
}
