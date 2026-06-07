import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const videoDevice = sequelize.define(
    'videoDevice',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(20),
        defaultValue: 'dvr',
      },
      brand: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      model: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      host: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      port: {
        type: DataTypes.INTEGER,
        defaultValue: 554,
      },
      httpPort: {
        type: DataTypes.INTEGER,
        defaultValue: 80,
      },
      username: {
        type: DataTypes.STRING(120),
        allowNull: true,
      },
      // Stored as-is for now; NEVER return it in API responses.
      // security TODO: encrypt.
      password: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      channels: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
      },
      protocol: {
        type: DataTypes.STRING(20),
        defaultValue: 'rtsp',
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'unknown',
      },
      lastSeenAt: {
        type: DataTypes.DATE,
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
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Media gateway (go2rtc/MediaMTX) base URL that converts this device's RTSP
      // into browser-playable WebRTC/HLS, and the chosen playback format.
      streamGatewayBase: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      streamFormat: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'hls',
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
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

  videoDevice.associate = (models) => {
    videoDevice.hasMany(models.videoCamera, { as: 'cameras', foreignKey: 'videoDeviceId' });
  };

  return videoDevice;
}
