import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const TenantUserClientAccounts = sequelize.define(
    'tenant_user_client_accounts',
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
      clientAccountId: {
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
      tableName: 'tenant_user_client_accounts',
      timestamps: true,
      paranoid: true,
    },
  );

  TenantUserClientAccounts.associate = (models) => {
    // pivot table model; associations handled via belongsToMany on tenantUser and clientAccount
  };

  return TenantUserClientAccounts;
}
