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
      wasRead: {
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

  incident.associate = (models) => {
    models.incident.belongsTo(models.station, {
      as: 'stationIncidents',
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
