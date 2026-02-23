import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const licenseType = sequelize.define(
    'licenseType',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'active',
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
          unique: true,
          fields: ['importHash', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
        {
          fields: ['tenantId'],
        },
        {
          fields: ['name', 'tenantId'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  licenseType.associate = (models) => {
    models.licenseType.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
        name: 'tenantId',
      },
    });

    models.licenseType.belongsTo(models.user, {
      as: 'createdBy',
      foreignKey: {
        name: 'createdById',
      },
    });

    models.licenseType.belongsTo(models.user, {
      as: 'updatedBy',
      foreignKey: {
        name: 'updatedById',
      },
    });
  };

  return licenseType;
}
