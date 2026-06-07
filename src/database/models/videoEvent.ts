import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const videoEvent = sequelize.define(
    'videoEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      videoCameraId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      videoDeviceId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING(20),
        defaultValue: 'manual',
      },
      severity: {
        type: DataTypes.STRING(12),
        defaultValue: 'medium',
      },
      at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(12),
        defaultValue: 'new',
      },
      acknowledgedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      incidentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      videoClipId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      postSiteId: {
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
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  videoEvent.associate = (models) => {
    videoEvent.belongsTo(models.videoCamera, { as: 'camera', foreignKey: 'videoCameraId' });
    videoEvent.belongsTo(models.videoDevice, { as: 'device', foreignKey: 'videoDeviceId' });
  };

  return videoEvent;
}
