/**
 * Per-tenant SMS account: the tenant's Twilio subaccount + prepaid wallet.
 * One row per tenant. The Twilio auth token is stored encrypted at rest.
 */
export default function (sequelize, DataTypes) {
  const tenantSmsAccount = sequelize.define(
    'tenantSmsAccount',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Twilio subaccount SID (ACxxxx) created under the platform master account.
      subaccountSid: { type: DataTypes.STRING(64), allowNull: true },
      // AES-GCM encrypted Twilio subaccount auth token.
      authTokenEnc: { type: DataTypes.TEXT, allowNull: true },
      // The sender assigned to this subaccount (E.164 number) or messaging service.
      phoneNumber: { type: DataTypes.STRING(32), allowNull: true },
      messagingServiceSid: { type: DataTypes.STRING(64), allowNull: true },
      // Prepaid balance in minor units (cents) of `currency`.
      balanceCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      // inactive | active | suspended
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'inactive' },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  tenantSmsAccount.associate = (models) => {
    models.tenantSmsAccount.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
  };

  return tenantSmsAccount;
}
