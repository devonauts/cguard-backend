/**
 * platformSetting — a tiny key/value store for PLATFORM-level configuration
 * managed from the superadmin panel (not tenant-scoped). Currently holds the
 * Stripe connection config under key 'stripe'. Secret values inside `value`
 * are encrypted at rest by the service layer (see lib/secretBox + stripeConfigService).
 */
export default function (sequelize, DataTypes) {
  const platformSetting = sequelize.define(
    'platformSetting',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      value: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      updatedByUserId: { type: DataTypes.UUID, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
    },
  );

  return platformSetting;
}
