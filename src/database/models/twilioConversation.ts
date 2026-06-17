/**
 * twilioConversation — a PLATFORM-LEVEL SMS thread between the single platform
 * Twilio number (`ourNumber`) and an external peer (`peerNumber`). Not
 * tenant-scoped: only superadmins use the platform phone center. One row per
 * distinct (peerNumber, ourNumber) pair; messages hang off it via twilioMessage.
 *
 * Managed by src/services/twilio/superadminMessagingService.ts.
 */
export default function (sequelize, DataTypes) {
  const twilioConversation = sequelize.define(
    'twilioConversation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // External peer in E.164 (the customer / contact we are texting with).
      peerNumber: { type: DataTypes.STRING(32), allowNull: false },
      // The platform Twilio number this thread is on (E.164).
      ourNumber: { type: DataTypes.STRING(32), allowNull: true },
      lastMessageAt: { type: DataTypes.DATE, allowNull: true },
      lastMessagePreview: { type: DataTypes.STRING(255), allowNull: true },
      unreadCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // open | closed | archived
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'open' },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ name: 'twilio_conv_peer', fields: ['peerNumber'] }],
    },
  );

  twilioConversation.associate = (models) => {
    models.twilioConversation.hasMany(models.twilioMessage, {
      as: 'messages',
      foreignKey: { name: 'conversationId', allowNull: false },
      onDelete: 'CASCADE',
    });
  };

  return twilioConversation;
}
