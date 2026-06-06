/**
 * superAdminAuditLog — an append-only record of every state-changing action
 * taken through the platform superadmin panel (tenant suspend/delete, billing
 * edits, user changes, etc.). Read by the panel's "Audit log" view.
 *
 * Not tenant-scoped (it spans tenants) and intentionally NOT paranoid: audit
 * rows are never soft-deleted.
 */
export default function (sequelize, DataTypes) {
  const superAdminAuditLog = sequelize.define(
    'superAdminAuditLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      /** The superadmin who performed the action. */
      actorUserId: { type: DataTypes.UUID, allowNull: true },
      actorEmail: { type: DataTypes.STRING(255), allowNull: true },
      /** Dotted action key, e.g. "tenant.suspend", "user.updateStatus". */
      action: { type: DataTypes.STRING(100), allowNull: false },
      /** What kind of entity was acted on, e.g. "tenant", "tenantUser". */
      targetType: { type: DataTypes.STRING(60), allowNull: true },
      /** Primary key of the acted-on entity. */
      targetId: { type: DataTypes.STRING(64), allowNull: true },
      /** The tenant affected by the action, when applicable. */
      tenantId: { type: DataTypes.UUID, allowNull: true },
      method: { type: DataTypes.STRING(10), allowNull: true },
      path: { type: DataTypes.STRING(512), allowNull: true },
      ip: { type: DataTypes.STRING(64), allowNull: true },
      statusCode: { type: DataTypes.INTEGER, allowNull: true },
      /** Free-form structured context (before/after, reason, body summary). */
      details: { type: DataTypes.JSON, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: false,
      indexes: [
        { fields: ['actorUserId'] },
        { fields: ['tenantId'] },
        { fields: ['action'] },
        { fields: ['createdAt'] },
      ],
    },
  );

  return superAdminAuditLog;
}
