/**
 * tenantWhatsappAccount — a tenant's OWN WhatsApp Business account, connected
 * via Meta Embedded Signup (Facebook Login for Business). The platform never
 * owns numbers: every send resolves this row first (fallback: the legacy global
 * Meta config in platformSettings during rollout).
 *
 * ONE account per tenant TODAY — enforced by the named unique index
 * `uniq_tenantWhatsappAccounts_tenantId` (see the create migration); drop that
 * index later to allow multiple numbers per tenant.
 *
 * accessToken is secretBox-ENCRYPTED at rest (services encrypt/decrypt; the
 * model stores whatever it is given). Tokens never leave the backend.
 */
export default function (sequelize, DataTypes) {
  const tenantWhatsappAccount = sequelize.define(
    'tenantWhatsappAccount',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Meta Business Manager id that owns the WABA (owner_business_info.id).
      metaBusinessId: { type: DataTypes.STRING(64), allowNull: true },
      // WhatsApp Business Account id — webhook entry.id routes on this.
      wabaId: { type: DataTypes.STRING(64), allowNull: true },
      phoneNumberId: { type: DataTypes.STRING(64), allowNull: true },
      displayPhoneNumber: { type: DataTypes.STRING(32), allowNull: true },
      // verified_name of the phone number.
      displayName: { type: DataTypes.STRING(255), allowNull: true },
      // Name of the owning Meta business.
      businessName: { type: DataTypes.STRING(255), allowNull: true },
      // Business integration system-user token, secretBox-encrypted.
      accessToken: { type: DataTypes.TEXT, allowNull: true },
      // Business integration tokens generally don't expire — kept for future
      // token-refresh support.
      tokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
      qualityRating: { type: DataTypes.STRING(16), allowNull: true },
      messagingLimit: { type: DataTypes.STRING(32), allowNull: true },
      // connected | disconnected | pending | error
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'disconnected' },
      connectedAt: { type: DataTypes.DATE, allowNull: true },
      disconnectedAt: { type: DataTypes.DATE, allowNull: true },
      lastSyncAt: { type: DataTypes.DATE, allowNull: true },
      connectedByUserId: { type: DataTypes.UUID, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ fields: ['wabaId'] }],
    },
  );

  tenantWhatsappAccount.associate = (models) => {
    models.tenantWhatsappAccount.belongsTo(models.tenant, {
      as: 'tenant',
      // tenantId is unique — one WhatsApp account per tenant (enforced by the
      // named index in the migration; drop it for multi-number support).
      foreignKey: { allowNull: false, unique: true },
    });
  };

  return tenantWhatsappAccount;
}
