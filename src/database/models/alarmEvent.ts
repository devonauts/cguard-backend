import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const alarmEvent = sequelize.define(
    'alarmEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      alarmSignalId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      alarmPanelId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      alarmZoneId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      category: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      priority: {
        type: DataTypes.INTEGER,
        defaultValue: 3,
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      zoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      alarmCaseId: {
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

  alarmEvent.associate = (models) => {
    alarmEvent.belongsTo(models.alarmCase, { as: 'case', foreignKey: 'alarmCaseId' });
    alarmEvent.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
    alarmEvent.belongsTo(models.alarmSignal, { as: 'signal', foreignKey: 'alarmSignalId' });
  };

  return alarmEvent;
}
