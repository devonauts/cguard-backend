import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const estimate = sequelize.define(
    'estimate',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      estimateNumber: {
        type: DataTypes.STRING(50),
        allowNull: false,
        validate: {
          len: [0, 50],
          notEmpty: true,
        }
      },
      poSoNumber: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: [0, 50],
        }
      },
      title: {
        type: DataTypes.STRING(100),
      },
      summary: {
        type: DataTypes.STRING(255),
      },
      date: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('date')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('date'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      expiryDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('expiryDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('expiryDate'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      items: {
        type: DataTypes.JSON,
      },
      notes: {
        type: DataTypes.STRING(1000),
      },
      subtotal: {
        type: DataTypes.DECIMAL,
      },
      total: {
        type: DataTypes.DECIMAL,
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
        {
          unique: true,
          fields: ['estimateNumber', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  estimate.associate = (models) => {
    models.estimate.belongsTo(models.clientAccount, {
      as: 'client',
      constraints: false,
    });

    models.estimate.belongsTo(models.businessInfo, {
      as: 'postSite',
      constraints: false,
    });

    models.estimate.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.estimate.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.estimate.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return estimate;
}
