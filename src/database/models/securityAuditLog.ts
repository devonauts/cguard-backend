import { DataTypes } from 'sequelize';

export default function (sequelize) {
  // Append-only audit trail of auth / session / device events.
  const securityAuditLog = sequelize.define(
    'securityAuditLog',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: true },
      userId: { type: DataTypes.UUID, allowNull: true },
      email: { type: DataTypes.STRING(255), allowNull: true },
      event: { type: DataTypes.STRING(40), allowNull: false },
      outcome: { type: DataTypes.STRING(20), allowNull: true },
      ip: { type: DataTypes.STRING(60), allowNull: true },
      userAgent: { type: DataTypes.STRING(400), allowNull: true },
      deviceId: { type: DataTypes.STRING(200), allowNull: true },
      platform: { type: DataTypes.STRING(40), allowNull: true },
      detail: { type: DataTypes.TEXT, allowNull: true },
      at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  return securityAuditLog;
}
