import { DataTypes } from 'sequelize';

export default function (sequelize) {
  // Append-only audit trail for alarm cases.
  const alarmAuditLog = sequelize.define(
    'alarmAuditLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      alarmCaseId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      action: {
        type: DataTypes.STRING(60),
        allowNull: true,
      },
      detail: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      actorId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  alarmAuditLog.associate = (models) => {
    alarmAuditLog.belongsTo(models.alarmCase, { as: 'case', foreignKey: 'alarmCaseId' });
  };

  return alarmAuditLog;
}
