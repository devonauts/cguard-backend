/**
 * Join table between tenantUsers and roles.
 *
 * NOTE (C6): This is the FUTURE SOURCE OF TRUTH for a tenantUser's roles.
 * Today, authorization still reads the serialized `tenantUser.roles`
 * string-array (see src/services/user/permissionChecker.ts). This table is
 * kept in sync from that string-array (see src/services/roleSync.ts ->
 * syncTenantUserRoleRows) so it is fully populated and FK-backed, ready to
 * become authoritative later. Do NOT make it the read path yet.
 */
export default function (sequelize, DataTypes) {
  const tenantUserRole = sequelize.define(
    'tenantUserRole',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenantUsers',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      roleId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'roles',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      tableName: 'tenantUserRoles',
      timestamps: true,
      paranoid: true,
      indexes: [
        {
          unique: true,
          fields: ['tenantUserId', 'roleId'],
          where: {
            deletedAt: null,
          },
        },
      ],
    },
  );

  tenantUserRole.associate = (models) => {
    models.tenantUserRole.belongsTo(models.tenantUser, {
      as: 'tenantUser',
      foreignKey: {
        name: 'tenantUserId',
        allowNull: false,
      },
      onDelete: 'CASCADE',
    });

    models.tenantUserRole.belongsTo(models.role, {
      as: 'role',
      foreignKey: {
        name: 'roleId',
        allowNull: false,
      },
      onDelete: 'CASCADE',
    });
  };

  return tenantUserRole;
}
