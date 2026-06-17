/**
 * twilioMessage — a single SMS/MMS in a platform Twilio conversation. Inbound
 * rows are created by the Twilio SMS webhook; outbound rows by the superadmin
 * composer. `twilioSid` links a row to Twilio's message resource so status
 * callbacks can update it via updateMessageStatus(). Platform-scoped.
 *
 * Managed by src/services/twilio/superadminMessagingService.ts.
 */
export default function (sequelize, DataTypes) {
  const twilioMessage = sequelize.define(
    'twilioMessage',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      conversationId: { type: DataTypes.UUID, allowNull: false },
      // inbound | outbound
      direction: { type: DataTypes.STRING(16), allowNull: false },
      fromNumber: { type: DataTypes.STRING(32), allowNull: true },
      toNumber: { type: DataTypes.STRING(32), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: true },
      // Twilio message SID (SMxx…); null until Twilio accepts an outbound send.
      twilioSid: { type: DataTypes.STRING(64), allowNull: true },
      // inbound default 'received'; outbound lifecycle queued|sent|delivered|failed|undelivered
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'received' },
      mediaUrls: { type: DataTypes.JSON, allowNull: true },
      errorMessage: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [
        { name: 'twilio_msg_conv', fields: ['conversationId'] },
        { name: 'twilio_msg_sid', fields: ['twilioSid'] },
      ],
    },
  );

  twilioMessage.associate = (models) => {
    models.twilioMessage.belongsTo(models.twilioConversation, {
      as: 'conversation',
      foreignKey: { name: 'conversationId', allowNull: false },
    });
  };

  return twilioMessage;
}
