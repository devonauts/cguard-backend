import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const shift = sequelize.define(
    'shift',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      startTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      endTime: {
        type: DataTypes.DATE,
        allowNull: false,
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

  shift.associate = (models) => {
    models.shift.belongsTo(models.station, {
      as: 'station',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.shift.belongsTo(models.user, {
      as: 'guard',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });


    
    models.shift.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.shift.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.shift.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return shift;
}
