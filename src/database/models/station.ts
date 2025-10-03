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
        allowNull: false,
        validate: {
          len: [0, 100],
          notEmpty: true,
        }
      },
      longitud: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          len: [0, 100],
          notEmpty: true,
        }
      },
      numberOfGuardsInStation: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "1",
            "2",
            "3",
            "4"
          ]],
        }
      },
      stationSchedule: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "1 hora",
            "4 horas",
            "8 horas",
            "10 horas",
            "12 horas",
            "14 horas",
            "16 horas",
            "24 horas"
          ]],
        }
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
