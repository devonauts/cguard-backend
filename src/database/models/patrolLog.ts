import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const patrolLog = sequelize.define(
    'patrolLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      scanTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      latitude: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        }
      },
      longitude: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        }
      },
      validLocation: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      status: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "\"Pending\"",
            "\"Scanned\"",
            "\"Missed\""
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

  patrolLog.associate = (models) => {
    models.patrolLog.belongsTo(models.patrol, {
      as: 'patrol',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrolLog.belongsTo(models.user, {
      as: 'scannedBy',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });


    
    models.patrolLog.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.patrolLog.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.patrolLog.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return patrolLog;
}
