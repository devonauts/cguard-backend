import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const deviceIdInformation = sequelize.define(
    'deviceIdInformation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      deviceId: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
        }
      },
      platform: { type: DataTypes.STRING(40), allowNull: true },
      model: { type: DataTypes.STRING(120), allowNull: true },
      manufacturer: { type: DataTypes.STRING(120), allowNull: true },
      osVersion: { type: DataTypes.STRING(60), allowNull: true },
      appVersion: { type: DataTypes.STRING(40), allowNull: true },
      pushToken: { type: DataTypes.TEXT, allowNull: true },
      // Raw APNs device token (hex) for the native Mi Seguridad client app —
      // delivered direct via node-apn (apnsService), not FCM.
      apnsToken: { type: DataTypes.TEXT, allowNull: true },
      isBound: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      flagged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lastSeenAt: { type: DataTypes.DATE, allowNull: true },
      lastMismatchAt: { type: DataTypes.DATE, allowNull: true },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['importHash', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },

      ],
      timestamps: true,
      paranoid: true,
    },
  );

  deviceIdInformation.associate = (models) => {



    
    models.deviceIdInformation.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    // The guard who owns / uses this device.
    models.deviceIdInformation.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'userId',
    });

    // The client account whose app registered this device (customer push). Lets push
    // resolve tokens by clientAccountId directly, independent of clientAccount.userId.
    models.deviceIdInformation.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
    });

    models.deviceIdInformation.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.deviceIdInformation.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return deviceIdInformation;
}
