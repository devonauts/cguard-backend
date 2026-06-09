import { DataTypes } from 'sequelize';

/**
 * A single message in a conversation. body is a wide TEXT column (NOT the legacy
 * notification STRING(200)). clientMsgId is a client-generated idempotency key:
 * a retry/double-tap with the same key returns the existing row instead of
 * duplicating (enforced by the partial unique index in the migration).
 */
export default function (sequelize) {
  const message = sequelize.define(
    'message',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      conversationId: { type: DataTypes.UUID, allowNull: false },
      senderUserId: { type: DataTypes.UUID, allowNull: false },
      senderType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: { isIn: [['staff', 'guard', 'client']] },
      },
      body: { type: DataTypes.TEXT, allowNull: false },
      // Image/video attachments: [{ url, type: 'image'|'video', name, sizeInBytes }].
      attachments: { type: DataTypes.JSON, allowNull: true },
      clientMsgId: { type: DataTypes.STRING(64), allowNull: true },
      importHash: { type: DataTypes.STRING(255), allowNull: true, validate: { len: [0, 255] } },
    },
    {
      indexes: [
        { fields: ['tenantId', 'conversationId', 'createdAt'] },
        { unique: true, fields: ['importHash', 'tenantId'], where: { deletedAt: null } },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  message.associate = (models) => {
    models.message.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
    models.message.belongsTo(models.messageConversation, { as: 'conversation', foreignKey: 'conversationId', constraints: false });
    models.message.belongsTo(models.user, { as: 'sender', foreignKey: 'senderUserId', constraints: false });
    models.message.hasMany(models.messageReceipt, { as: 'receipts', foreignKey: 'messageId', constraints: false });
  };

  return message;
}
