import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const videoCamera = sequelize.define(
    'videoCamera',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      videoDeviceId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      channel: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
      },
      name: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      rtspUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // HLS/WebRTC playback URL from the media gateway.
      streamUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      snapshotUrl: {
        type: DataTypes.STRING(500),
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
      enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'unknown',
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  videoCamera.associate = (models) => {
    videoCamera.belongsTo(models.videoDevice, { as: 'device', foreignKey: 'videoDeviceId' });
  };

  return videoCamera;
}
