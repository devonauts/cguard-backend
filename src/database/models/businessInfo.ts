import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const businessInfo = sequelize.define(
    'businessInfo',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      companyName: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        }
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 5000],
          notEmpty: true,
        }
      },
      contactPhone: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        }
      },
      contactEmail: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
        }
      },
      latitud: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      longitud: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
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
      secondAddress: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          len: [0, 200],
        }
      },
      country: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100],
        }
      },
      postalCode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
        }
      },
      address: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
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

  businessInfo.associate = (models) => {

    // Relación con cliente (opcional)
    models.businessInfo.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: {
        allowNull: true,
      },
      constraints: false,
    });

    models.businessInfo.hasMany(models.file, {
      as: 'logo',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.businessInfo.getTableName(),
        belongsToColumn: 'logo',
      },
    });
    
    models.businessInfo.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.businessInfo.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.businessInfo.belongsTo(models.user, {
      as: 'updatedBy',
    });
    
    // Assign postSites to tenantUsers
    models.businessInfo.belongsToMany(models.tenantUser, {
      through: 'tenant_user_post_sites',
      foreignKey: 'businessInfoId',
      otherKey: 'tenantUserId',
      as: 'assignedTenantUsers',
      constraints: false,
    });
  };

  return businessInfo;
}
