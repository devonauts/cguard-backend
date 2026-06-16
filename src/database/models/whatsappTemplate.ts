/**
 * whatsappTemplate — registry of approved Meta WhatsApp message templates the
 * platform sends. WhatsApp business-initiated messages outside the 24h window
 * MUST use a pre-approved template; this table maps our internal message types
 * to template names + the number of body params they expect.
 *
 * tenantId NULL = global/default template (shared across tenants). A tenant may
 * later register its own brand-approved template under the same `name`.
 */
export default function (sequelize, DataTypes) {
  const whatsappTemplate = sequelize.define(
    'whatsappTemplate',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // null tenantId = global default template.
      tenantId: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING(128), allowNull: false },
      languageCode: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'es' },
      // UTILITY | AUTHENTICATION | MARKETING (Meta template categories).
      category: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UTILITY' },
      bodyParamsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ fields: ['tenantId', 'name', 'languageCode'] }],
    },
  );

  // No hard FK on tenantId (NULL = global). Tenant scoping is enforced in the
  // service layer; keeping it FK-free avoids ordering issues with global seeds.
  return whatsappTemplate;
}
