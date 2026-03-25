import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const incident = sequelize.define(
    'incident',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      date: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
          notEmpty: true,
        }
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 2500],
          notEmpty: true,
        }
      },
      callerName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
        callerType: {
          type: DataTypes.STRING(50),
          allowNull: true,
        },
        status: {
          type: DataTypes.STRING(50),
          allowNull: false,
          defaultValue: 'abierto',
          validate: {
            isIn: [[
              'abierto',
              'cerrado',
            ]],
          },
        },
        dateTime: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        incidentAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        subject: {
          type: DataTypes.STRING(255),
          allowNull: true,
          validate: {
            len: [0, 255],
          },
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        action: {
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        priority: {
          type: DataTypes.STRING(50),
          allowNull: true,
        },
        internalNotes: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        actionsTaken: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        location: {
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        comments: {
          type: DataTypes.JSON,
          allowNull: true,
        },
        stationId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        stationIncidentsId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        clientId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        siteId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        postSiteId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        guardNameId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
      wasRead: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      incidentTypeId: {
        type: DataTypes.UUID,
        allowNull: true,
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

  incident.associate = (models) => {
    models.incident.belongsTo(models.station, {
      as: 'stationIncidents',
      constraints: false,
    });

    models.incident.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
      foreignKey: 'guardNameId',
    });

    models.incident.belongsTo(models.clientAccount, {
      as: 'client',
      foreignKey: 'clientId',
      constraints: false,
    });

    models.incident.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.incident.belongsTo(models.businessInfo, {
      as: 'site',
      foreignKey: 'siteId',
      constraints: false,
    });

    models.incident.belongsTo(models.incidentType, {
      as: 'incidentType',
      constraints: false,
    });

    models.incident.hasMany(models.file, {
      as: 'imageUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.incident.getTableName(),
        belongsToColumn: 'imageUrl',
      },
    });
    
    models.incident.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.incident.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.incident.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return incident;
}
