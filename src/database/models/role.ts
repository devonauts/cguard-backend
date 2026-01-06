import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const role = sequelize.define(
    'role',
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
          len: [1, 200],
          notEmpty: true,
        },
      },
      slug: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          len: [1, 100],
          notEmpty: true,
        },
      },
      description: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },
      permissions: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['slug', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  role.associate = (models) => {
    role.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    role.belongsTo(models.user, {
      as: 'createdBy',
    });
    role.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return role;
}
