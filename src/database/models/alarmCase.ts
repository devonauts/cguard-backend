import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const alarmCase = sequelize.define(
    'alarmCase',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      alarmPanelId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        defaultValue: 'queued',
      },
      priority: {
        type: DataTypes.INTEGER,
        defaultValue: 3,
      },
      category: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      assignedOperatorId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      ackAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      dispatchAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      resolvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      closedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      disposition: {
        type: DataTypes.STRING(16),
        allowNull: true,
      },
      incidentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      dispatchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      customerId: {
        type: DataTypes.UUID,
        allowNull: true,
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

  alarmCase.associate = (models) => {
    alarmCase.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
    alarmCase.hasMany(models.alarmEvent, { as: 'events', foreignKey: 'alarmCaseId' });
    alarmCase.hasMany(models.alarmDispatch, { as: 'dispatches', foreignKey: 'alarmCaseId' });
    alarmCase.hasMany(models.alarmAuditLog, { as: 'auditLogs', foreignKey: 'alarmCaseId' });
  };

  return alarmCase;
}
