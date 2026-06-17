/**
 * twilioCall — a PLATFORM-LEVEL voice call log entry (inbound or outbound)
 * placed/received through the in-browser superadmin softphone. One row per
 * Twilio call SID, updated as voice status callbacks arrive. Platform-scoped.
 *
 * Managed by src/services/twilio/superadminCallService.ts.
 */
export default function (sequelize, DataTypes) {
  const twilioCall = sequelize.define(
    'twilioCall',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Twilio call SID (CAxx…). Unique per call.
      callSid: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      // inbound | outbound
      direction: { type: DataTypes.STRING(16), allowNull: false },
      fromNumber: { type: DataTypes.STRING(32), allowNull: true },
      toNumber: { type: DataTypes.STRING(32), allowNull: true },
      // queued|ringing|in-progress|completed|busy|failed|no-answer|canceled
      status: { type: DataTypes.STRING(24), allowNull: true },
      durationSec: { type: DataTypes.INTEGER, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      endedAt: { type: DataTypes.DATE, allowNull: true },
      recordingUrl: { type: DataTypes.STRING(512), allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ name: 'twilio_call_sid', fields: ['callSid'] }],
    },
  );

  return twilioCall;
}
