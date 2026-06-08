import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const videoClip = sequelize.define(
    'videoClip',
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
      startAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      endAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      durationSec: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      url: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      thumbnailUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      label: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(12),
        defaultValue: 'pending',
      },
      incidentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Phase 3: the alarm case this clip verifies (auto-captured on alarm).
      alarmCaseId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      shareToken: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      shareExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
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

  videoClip.associate = (models) => {
    videoClip.belongsTo(models.videoCamera, { as: 'camera', foreignKey: 'videoCameraId' });
    videoClip.belongsTo(models.videoDevice, { as: 'device', foreignKey: 'videoDeviceId' });
  };

  return videoClip;
}
