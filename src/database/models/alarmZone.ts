import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const alarmZone = sequelize.define(
    'alarmZone',
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
      zoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING(20),
        defaultValue: 'motion',
      },
      partition: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },
      linkedCameraId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      bypassed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
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

  alarmZone.associate = (models) => {
    alarmZone.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
  };

  return alarmZone;
}
