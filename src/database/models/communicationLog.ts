/**
 * communicationLog — one row per outbound delivery attempt across the unified
 * communications layer (push / whatsapp / sms / email). Written by the
 * CommunicationService/MessageRouter for every channel attempt (including
 * 'skipped' when a paid channel is blocked by an empty wallet). Tenant-scoped.
 *
 * providerMessageId lets webhooks (e.g. Meta WhatsApp status callbacks) update
 * delivery status after the fact via updateStatusByProviderMessageId().
 */
export default function (sequelize, DataTypes) {
  const communicationLog = sequelize.define(
    'communicationLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // null userId = broadcast / tenant-wide / recipient not tied to a user.
      userId: { type: DataTypes.UUID, allowNull: true },
      // E.164 phone, email, FCM token id, or 'push' marker depending on channel.
      recipient: { type: DataTypes.STRING(255), allowNull: true },
      // push | whatsapp | sms | email
      channel: { type: DataTypes.STRING(16), allowNull: false },
      // firebase | meta | twilio | smtp | etc.
      provider: { type: DataTypes.STRING(32), allowNull: true },
      // MessageType enum (otp | shift_reminder | incident_alert | ...).
      messageType: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'generic' },
      // queued | sent | delivered | read | failed | skipped
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
      providerMessageId: { type: DataTypes.STRING(128), allowNull: true },
      providerResponse: { type: DataTypes.JSON, allowNull: true },
      errorMessage: { type: DataTypes.TEXT, allowNull: true },
      costEstimateCents: { type: DataTypes.INTEGER, allowNull: true },
      billedAmountCents: { type: DataTypes.INTEGER, allowNull: true },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      deepLink: { type: DataTypes.STRING(255), allowNull: true },
      deliveredAt: { type: DataTypes.DATE, allowNull: true },
      readAt: { type: DataTypes.DATE, allowNull: true },
      failedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [
        { fields: ['tenantId', 'createdAt'] },
        { fields: ['providerMessageId'] },
      ],
    },
  );

  communicationLog.associate = (models) => {
    models.communicationLog.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
  };

  return communicationLog;
}
