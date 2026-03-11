import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const TenantUserPostSite = sequelize.define(
    'tenant_user_postsite',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantUserId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      businessInfoId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      security_guard_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'securityGuards',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'tenant_user_postsite',
      timestamps: true,
      paranoid: true,
    },
  );

  TenantUserPostSite.associate = (models) => {
    // pivot table model; associations handled via belongsToMany on tenantUser and businessInfo
  };

  return TenantUserPostSite;
}
