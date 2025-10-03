import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const notificationRecipient = sequelize.define(
    'notificationRecipient',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      recipientId: {
        type: DataTypes.TEXT,
      },
      readStatus: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      deliveryStatus: {
        type: DataTypes.TEXT,
        validate: {
          isIn: [[
            "Pending",
            "Delivered",
            "Failed"
          ]],
        }
      },
      dateDelivered: {
        type: DataTypes.DATE,
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

  notificationRecipient.associate = (models) => {
    models.notificationRecipient.belongsTo(models.notification, {
      as: 'notification',
      constraints: false,
    });


    
    models.notificationRecipient.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.notificationRecipient.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.notificationRecipient.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return notificationRecipient;
}
