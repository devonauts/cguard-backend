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
      // True for the built-in/system roles seeded per tenant (admin, dispatcher,
      // securityGuard, …). System roles are editable (permissions) but never
      // deletable; custom roles have isSystem=false.
      isSystem: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // True once a tenant has edited a system role's permissions away from its
      // static defaults. Lets the checker treat the DB set as authoritative even
      // when emptied, and powers "reset to default".
      isCustomized: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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

    // C6: real role membership via the tenantUserRoles join table.
    role.belongsToMany(models.tenantUser, {
      through: models.tenantUserRole,
      foreignKey: 'roleId',
      otherKey: 'tenantUserId',
      as: 'tenantUsers',
    });
  };

  return role;
}
