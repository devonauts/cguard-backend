import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const clientAccount = sequelize.define(
    'clientAccount',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      lastName: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          len: [0, 200],
        }
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: true,
        validate: {
          len: [0, 150],
        }
      },
      phoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
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
      addressComplement: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          len: [0, 200],
        }
      },
      zipCode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      country: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      useSameAddressForBilling: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      faxNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      website: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        }
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255],
        },
      },
      categoryIds: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
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
    // Multi-tenant relationship
    models.clientAccount.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    // Audit relationships
    models.clientAccount.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.clientAccount.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return clientAccount;
}