import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const patrol = sequelize.define(
    'patrol',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      scheduledTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      completed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      completionTime: {
        type: DataTypes.DATE,
      },
      status: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "Completed",
            "Incomplete"
          ]],
        }
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

  patrol.associate = (models) => {
    models.patrol.belongsTo(models.user, {
      as: 'assignedGuard',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrol.belongsTo(models.station, {
      as: 'station',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrol.belongsToMany(models.patrolCheckpoint, {
      as: 'checkpoints',
      constraints: false,
      through: 'patrolCheckpointPatrolsPatrolCheckpoints',
    });

    models.patrol.hasMany(models.patrolLog, {
      as: 'logs',
      constraints: false,
      foreignKey: 'patrolId',
    });


    
    models.patrol.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrol.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.patrol.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return patrol;
}
