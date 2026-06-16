/**
 * whatsappInboundSession — tracks the last time a given phone messaged a tenant
 * on WhatsApp. Meta only permits free-form (non-template) business messages
 * within a 24h "customer-service window" that opens each time the user sends an
 * inbound message. The Meta webhook upserts lastInboundAt here on every inbound;
 * metaWhatsAppProvider reads it to decide template-vs-text and refuses free-form
 * sends outside the window.
 *
 * Keyed by (tenantId, phone). phone is stored in normalized E.164-ish form
 * (digits, leading '+'). Not paranoid; this is rolling operational state.
 */
export default function (sequelize, DataTypes) {
  const whatsappInboundSession = sequelize.define(
    'whatsappInboundSession',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      // E.164-normalized sender phone (e.g. +593...). Unique per tenant.
      phone: { type: DataTypes.STRING(32), allowNull: false },
      lastInboundAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ unique: true, fields: ['tenantId', 'phone'] }],
    },
  );

  // No hard FK: webhook traffic may arrive for any tenant phone; scoping is
  // enforced in the service layer and the unique (tenantId, phone) index.
  return whatsappInboundSession;
}
