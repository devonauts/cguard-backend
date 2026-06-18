/**
 * superadminNotification — a PLATFORM-LEVEL notification for superadmins. Every
 * platform event worth surfacing (incoming call, inbound SMS, …) writes a row
 * here; the SuperAdmin notification center lists/CRUDs them and uses `link` to
 * route the user exactly where they need to go on click. Platform-scoped.
 *
 * Managed by src/services/superadmin/superadminNotificationService.ts.
 */
export default function (sequelize, DataTypes) {
  const superadminNotification = sequelize.define(
    'superadminNotification',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Dotted source key, e.g. call.incoming | sms.inbound | tenant.created
      type: { type: DataTypes.STRING(48), allowNull: false },
      title: { type: DataTypes.STRING(180), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: true },
      // Frontend route to navigate to on click (e.g. /phone, /tenants/:id).
      link: { type: DataTypes.STRING(255), allowNull: true },
      // Optional icon hint for the UI (lucide name).
      icon: { type: DataTypes.STRING(32), allowNull: true },
      isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      metadata: { type: DataTypes.JSON, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [{ name: 'sa_notif_read_created', fields: ['isRead', 'createdAt'] }],
    },
  );

  return superadminNotification;
}
