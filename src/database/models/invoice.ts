import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const invoice = sequelize.define(
    'invoice',
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
      dueDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('dueDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('dueDate'))
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

  invoice.associate = (models) => {
    models.invoice.belongsTo(models.clientAccount, {
      as: 'client',
      constraints: false,
    });

    models.invoice.belongsTo(models.businessInfo, {
      as: 'postSite',
      constraints: false,
    });

    models.invoice.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.invoice.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.invoice.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return invoice;
}
