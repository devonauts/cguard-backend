import { DataTypes } from 'sequelize';

/**
 * Per-recipient delivery/read receipt for a message — the thing the legacy
 * notification model (a single global boolean) could not express. One row per
 * (message, recipientUserId). Unread badge = COUNT receipts WHERE
 * recipientUserId = self AND deliveryStatus != 'read'.
 */
export default function (sequelize) {
  const messageReceipt = sequelize.define(
    'messageReceipt',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      messageId: { type: DataTypes.UUID, allowNull: false },
      conversationId: { type: DataTypes.UUID, allowNull: false },
      recipientUserId: { type: DataTypes.UUID, allowNull: false },
      deliveryStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        validate: { isIn: [['pending', 'delivered', 'read']] },
      },
      deliveredAt: { type: DataTypes.DATE, allowNull: true },
      readAt: { type: DataTypes.DATE, allowNull: true },
      // Set once an "unread after 5 min" email reminder has been sent (at most once).
      reminderSentAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      indexes: [
        { fields: ['tenantId', 'recipientUserId', 'deliveryStatus'] },
        { fields: ['tenantId', 'conversationId', 'recipientUserId'] },
        { fields: ['messageId'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  messageReceipt.associate = (models) => {
    models.messageReceipt.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
    models.messageReceipt.belongsTo(models.message, { as: 'message', foreignKey: 'messageId', constraints: false });
  };

  return messageReceipt;
}
