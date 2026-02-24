import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const TenantUserPostSites = sequelize.define(
    'tenant_user_post_sites',
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
      site_tours: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      tasks: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      post_orders: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      checklists: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      skill_set: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      department: {
        type: DataTypes.JSON,
        allowNull: true,
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
      tableName: 'tenant_user_post_sites',
      timestamps: true,
      paranoid: true,
    },
  );

  TenantUserPostSites.associate = (models) => {
    // No additional associations required; defined as pivot table
  };

  return TenantUserPostSites;
}
