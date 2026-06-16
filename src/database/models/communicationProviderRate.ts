/**
 * communicationProviderRate — pricing table used to estimate the cost of a paid
 * send (whatsapp / sms) and the amount to debit from the tenant wallet. Rates
 * are resolved most-specific-first: (provider, channel, countryCode, messageType)
 * where countryCode/messageType NULL acts as a '*' wildcard. costCents is the
 * pass-through provider cost; markupPercentage is added on top to bill the tenant.
 *
 * This is platform-global config (not tenant-scoped) — seeded with sensible
 * defaults in the migration and editable from the superadmin panel later.
 */
export default function (sequelize, DataTypes) {
  const communicationProviderRate = sequelize.define(
    'communicationProviderRate',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      provider: { type: DataTypes.STRING(32), allowNull: false }, // twilio | meta | firebase | smtp
      channel: { type: DataTypes.STRING(16), allowNull: false }, // push | whatsapp | sms | email
      // NULL countryCode = '*' wildcard (any country). E.g. '+593', 'US', 'EC'.
      countryCode: { type: DataTypes.STRING(8), allowNull: true },
      // NULL messageType = '*' wildcard (any message type).
      messageType: { type: DataTypes.STRING(32), allowNull: true },
      costCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      markupPercentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ fields: ['provider', 'channel', 'countryCode', 'messageType'] }],
    },
  );

  return communicationProviderRate;
}
