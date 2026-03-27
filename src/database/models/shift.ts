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
      tenantUserId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      siteTours: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      tasks: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      postOrders: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      checklists: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      skillSet: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      department: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'stations',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
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

    models.shift.belongsTo(models.tenantUser, {
      as: 'tenantUser',
      foreignKey: 'tenantUserId',
      constraints: false,
    });


    
    models.shift.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.shift.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
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
