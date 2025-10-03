import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const guardShift = sequelize.define(
    'guardShift',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      punchInTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      shiftSchedule: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Diurno",
            "Nocturno"
          ]],
        }
      },
      numberOfPatrolsDuringShift: {
        type: DataTypes.INTEGER,
      },
      numberOfIncidentsDurindShift: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {

        }
      },
      observations: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 500],
          notEmpty: true,
        }
      },
      punchOutTime: {
        type: DataTypes.DATE,
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

  guardShift.associate = (models) => {
    models.guardShift.belongsTo(models.station, {
      as: 'stationName',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardShift.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardShift.belongsTo(models.inventoryHistory, {
      as: 'completeInventoryCheck',
      constraints: false,
    });

    models.guardShift.belongsToMany(models.patrolLog, {
      as: 'patrolsDone',
      constraints: false,
      through: 'guardShiftPatrolsDonePatrolLog',
    });

    models.guardShift.belongsToMany(models.incident, {
      as: 'dailyIncidents',
      constraints: false,
      through: 'guardShiftDailyIncidentsIncident',
    });


    
    models.guardShift.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardShift.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.guardShift.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return guardShift;
}
