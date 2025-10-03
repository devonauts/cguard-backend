import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const patrolCheckpoint = sequelize.define(
    'patrolCheckpoint',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        }
      },
      latitud: {
        type: DataTypes.TEXT,
      },
      longitud: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
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

  patrolCheckpoint.associate = (models) => {
    models.patrolCheckpoint.belongsTo(models.station, {
      as: 'station',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrolCheckpoint.belongsToMany(models.patrol, {
      as: 'patrols',
      constraints: false,
      through: 'patrolCheckpointPatrolsPatrolCheckpoints',
    });

    models.patrolCheckpoint.hasMany(models.file, {
      as: 'assignedQrImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.patrolCheckpoint.getTableName(),
        belongsToColumn: 'assignedQrImage',
      },
    });
    
    models.patrolCheckpoint.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrolCheckpoint.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.patrolCheckpoint.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return patrolCheckpoint;
}
