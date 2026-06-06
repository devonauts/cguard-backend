/**
 * Ledger of SMS wallet movements: recharges (credit) and message sends (debit).
 * amountCents is positive for credits, negative for debits.
 */
export default function (sequelize, DataTypes) {
  const smsTransaction = sequelize.define(
    'smsTransaction',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      type: { type: DataTypes.STRING(12), allowNull: false }, // recharge | debit | refund | adjustment
      amountCents: { type: DataTypes.INTEGER, allowNull: false },
      balanceAfterCents: { type: DataTypes.INTEGER, allowNull: true },
      smsCount: { type: DataTypes.INTEGER, allowNull: true },
      currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
      // Stripe checkout/session id or Twilio message SID — also used for idempotency.
      reference: { type: DataTypes.STRING(128), allowNull: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  smsTransaction.associate = (models) => {
    models.smsTransaction.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
  };

  return smsTransaction;
}
