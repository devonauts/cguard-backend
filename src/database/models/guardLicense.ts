import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const guardLicense = sequelize.define(
    'guardLicense',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      licenseTypeId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      customName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      number: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      issueDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expiryDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenants',
          key: 'id',
        },
      },
      createdById: {
        type: DataTypes.UUID,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      updatedById: {
        type: DataTypes.UUID,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        unique: true,
      },
    },
    {
      indexes: [
        {
          fields: ['tenantId'],
        },
        {
          fields: ['guardId'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  guardLicense.associate = (models) => {
    models.guardLicense.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: {
        name: 'guardId',
      },
    });

    models.guardLicense.belongsTo(models.licenseType, {
      as: 'licenseType',
      foreignKey: {
        name: 'licenseTypeId',
      },
    });

    models.guardLicense.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
        name: 'tenantId',
      },
    });

    models.guardLicense.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.guardLicense.belongsTo(models.user, {
      as: 'updatedBy',
    });

    models.guardLicense.hasMany(models.file, {
      as: 'frontImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.guardLicense.getTableName(),
        belongsToColumn: 'frontImage',
      },
    });

    models.guardLicense.hasMany(models.file, {
      as: 'backImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.guardLicense.getTableName(),
        belongsToColumn: 'backImage',
      },
    });
  };

  return guardLicense;
}
