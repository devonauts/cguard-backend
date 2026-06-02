import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const visitorLog = sequelize.define(
    'visitorLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      visitDate: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      lastName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      firstName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      idNumber: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      exitTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      numPeople: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      clientId: {
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
      stationName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      placeType: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      // --- Additional legal / important visit data ---
      idType: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      personVisited: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      company: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      vehiclePlate: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },
      vehicleType: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      tagNumber: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      phone: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },
      birthDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      idExpiry: {
        type: DataTypes.DATEONLY,
        allowNull: true,
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

  visitorLog.associate = (models) => {
    models.visitorLog.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.visitorLog.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.visitorLog.belongsTo(models.user, {
      as: 'updatedBy',
    });

    models.visitorLog.belongsTo(models.clientAccount, {
      as: 'client',
      foreignKey: 'clientId',
    });

    models.visitorLog.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
    });

    models.visitorLog.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });
  };

  return visitorLog;
}
