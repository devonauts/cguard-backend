/**
 * communicationWallet — prepaid balance for the unified communications layer.
 * One row per tenant. Debited before paid-channel sends (whatsapp / sms),
 * credited on recharge. Seeded from tenantSmsAccount.balanceCents at migration
 * time where a legacy SMS wallet exists. Push/email never touch the wallet.
 */
export default function (sequelize, DataTypes) {
  const communicationWallet = sequelize.define(
    'communicationWallet',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      balanceCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      lowBalanceThresholdCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 500 },
    },
    {
      timestamps: true,
      paranoid: false,
    },
  );

  communicationWallet.associate = (models) => {
    models.communicationWallet.belongsTo(models.tenant, {
      as: 'tenant',
      // tenantId is unique — one wallet per tenant (enforced in migration).
      foreignKey: { allowNull: false, unique: true },
    });
  };

  return communicationWallet;
}
