import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const inventoryHistory = sequelize.define(
    'inventoryHistory',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      inventoryCheckedDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('inventoryCheckedDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('inventoryCheckedDate'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      isComplete: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      observation: {
        type: DataTypes.TEXT,
        validate: {
          len: [0, 500],
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

  inventoryHistory.associate = (models) => {
    models.inventoryHistory.belongsTo(models.guardShift, {
      as: 'shiftOrigin',
      constraints: false,
    });

    models.inventoryHistory.belongsTo(models.inventory, {
      as: 'inventoryOrigin',
      constraints: false,
    });


    
    models.inventoryHistory.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.inventoryHistory.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.inventoryHistory.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return inventoryHistory;
}
