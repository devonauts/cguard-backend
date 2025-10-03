import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const notification = sequelize.define(
    'notification',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(100),
        validate: {
          len: [0, 100],
        }
      },
      body: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
        }
      },
      targetType: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "All",
            "Client",
            "User"
          ]],
        }
      },
      targetId: {
        type: DataTypes.TEXT,
      },
      deliveryStatus: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "Pending",
            "Delivered",
            "Failed"
          ]],
        }
      },
      readStatus: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
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

  notification.associate = (models) => {
    models.notification.belongsToMany(models.deviceIdInformation, {
      as: 'deviceId',
      constraints: false,
      through: 'notificationDeviceIdDeviceIdInformation',
    });

    models.notification.belongsTo(models.user, {
      as: 'whoCreatedTheNotification',
      constraints: false,
    });

    models.notification.hasMany(models.file, {
      as: 'imageUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.notification.getTableName(),
        belongsToColumn: 'imageUrl',
      },
    });
    
    models.notification.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.notification.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.notification.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return notification;
}
