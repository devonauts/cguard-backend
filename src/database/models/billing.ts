import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const billing = sequelize.define(
    'billing',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      invoiceNumber: {
        type: DataTypes.STRING(50),
        allowNull: false,
        validate: {
          len: [0, 50],
          notEmpty: true,
        }
      },
      status: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Pendiente",
            "Aceptado",
            "Pagado",
            "Rechazado",
            "En Mora"
          ]],
        }
      },
      montoPorPagar: {
        type: DataTypes.DECIMAL,
      },
      lastPaymentDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('lastPaymentDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('lastPaymentDate'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      nextPaymentDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('nextPaymentDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('nextPaymentDate'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      description: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          len: [0, 100],
          notEmpty: true,
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
        {
          unique: true,
          fields: ['invoiceNumber', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  billing.associate = (models) => {
    models.billing.belongsTo(models.clientAccount, {
      as: 'clientsInvoiced',
      constraints: false,
    });

    models.billing.hasMany(models.file, {
      as: 'bill',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.billing.getTableName(),
        belongsToColumn: 'bill',
      },
    });
    
    models.billing.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.billing.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.billing.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return billing;
}
