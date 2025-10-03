import { DataTypes } from 'sequelize';import moment from 'moment';

export default function (sequelize) {
  const clientAccount = sequelize.define(
    'clientAccount',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      contractDate: {
        type: DataTypes.DATEONLY,
        get: function() {
          // @ts-ignore
          return this.getDataValue('contractDate')
            ? moment
                // @ts-ignore
                .utc(this.getDataValue('contractDate'))
                .format('YYYY-MM-DD')
            : null;
        },
      },
      rucNumber: {
        type: DataTypes.STRING(13),
        validate: {
          len: [0, 13],
        }
      },
      commercialName: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
        }
      },
      address: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      phoneNumber: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: {
          len: [0, 10],
          notEmpty: true,
        }
      },
      faxNumber: {
        type: DataTypes.STRING(10),
        validate: {
          len: [0, 10],
        }
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
        validate: {
          len: [0, 150],
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

      ],
      timestamps: true,
      paranoid: true,
    },
  );

  clientAccount.associate = (models) => {
    models.clientAccount.belongsTo(models.user, {
      as: 'representante',
      constraints: false,
    });

    models.clientAccount.belongsToMany(models.service, {
      as: 'purchasedServices',
      constraints: false,
      through: 'clientAccountPurchasedServicesService',
    });

    models.clientAccount.belongsToMany(models.station, {
      as: 'stations',
      constraints: false,
      through: 'clientAccountStationsStation',
    });

    models.clientAccount.belongsToMany(models.billing, {
      as: 'billingInvoices',
      constraints: false,
      through: 'clientAccountBillingInvoicesBilling',
    });

    models.clientAccount.belongsToMany(models.notificationRecipient, {
      as: 'pushNotifications',
      constraints: false,
      through: 'clientAccountPushNotificationsNotificationRecipient',
    });

    models.clientAccount.hasMany(models.file, {
      as: 'logoUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.clientAccount.getTableName(),
        belongsToColumn: 'logoUrl',
      },
    });

    models.clientAccount.hasMany(models.file, {
      as: 'placePictureUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.clientAccount.getTableName(),
        belongsToColumn: 'placePictureUrl',
      },
    });
    
    models.clientAccount.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.clientAccount.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.clientAccount.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return clientAccount;
}
