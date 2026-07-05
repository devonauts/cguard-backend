import { DataTypes } from 'sequelize';

/**
 * Per-user "delete conversation" (WhatsApp-style). A row means the given user
 * hid the conversation from THEIR inbox at `hiddenAt`; it stays hidden and their
 * message history before `hiddenAt` is cleared for them only. A newer inbound
 * message (lastMessageAt > hiddenAt) brings the chat back, exactly like WhatsApp.
 * Never affects other participants. Uniqueness of (userId, conversationId)
 * enforced in code (upsert the hiddenAt).
 */
export default function (sequelize) {
  const messageHidden = sequelize.define(
    'messageHidden',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      conversationId: { type: DataTypes.UUID, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      hiddenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      indexes: [
        { fields: ['tenantId', 'userId'] },
        { fields: ['tenantId', 'conversationId'] },
        { fields: ['tenantId', 'userId', 'conversationId'] },
      ],
    },
  );

  messageHidden.associate = (models) => {
    models.messageHidden.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false } });
  };

  return messageHidden;
}
