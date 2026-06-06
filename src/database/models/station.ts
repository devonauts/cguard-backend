import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const station = sequelize.define(
    'station',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      stationName: {
        type: DataTypes.STRING(250),
        allowNull: false,
        validate: {
          len: [0, 250],
          notEmpty: true,
        }
      },
      latitud: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      longitud: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      numberOfGuardsInStation: {
        type: DataTypes.TEXT,
      },
      stationSchedule: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      startingTimeInDay: {
        type: DataTypes.TEXT,
      },
      finishTimeInDay: {
        type: DataTypes.TEXT,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,    
        validate: {
          len: [0, 255],
        },    
      },
      geofenceRadius: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 100,
        comment: 'Radius in meters for clock-in geofence validation',
      },
      // Optional polygon geofence: JSON array of {lat,lng}. When ≥3 points are
      // present it takes precedence over the radius for clock-in validation.
      geofencePolygon: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('geofencePolygon');
          if (!raw) return null;
          if (typeof raw !== 'string') return raw;
          try { return JSON.parse(raw); } catch { return null; }
        },
        set(this: any, val: any) {
          this.setDataValue(
            'geofencePolygon',
            val == null ? null : typeof val === 'string' ? val : JSON.stringify(val),
          );
        },
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      scheduleType: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      rotationStyleId: {
        type: DataTypes.UUID,
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

  station.associate = (models) => {
    models.station.belongsTo(models.clientAccount, {
      as: 'stationOrigin',
      constraints: false,
    });

    models.station.belongsToMany(models.user, {
      as: 'assignedGuards',
      constraints: false,
      through: 'stationAssignedGuardsUser',
    });

    models.station.hasMany(models.task, {
      as: 'tasks',
      constraints: false,
      foreignKey: 'taskBelongsToStationId',
    });

    models.station.hasMany(models.report, {
      as: 'reports',
      constraints: false,
      foreignKey: 'stationId',
    });

    models.station.hasMany(models.incident, {
      as: 'incidents',
      constraints: false,
      foreignKey: 'stationIncidentsId',
    });

    models.station.hasMany(models.patrolCheckpoint, {
      as: 'checkpoints',
      constraints: false,
      foreignKey: 'stationId',
    });

    models.station.hasMany(models.patrol, {
      as: 'patrol',
      constraints: false,
      foreignKey: 'stationId',
    });

    models.station.belongsToMany(models.shift, {
      as: 'shift',
      constraints: false,
      through: 'stationShiftShift',
    });

    models.station.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
    });


    
    models.station.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.station.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.station.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return station;
}
