export default function (sequelize, DataTypes) {
  const tenantInvitation = sequelize.define(
    'tenantInvitation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      token: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      // Disable paranoid (soft-delete) for tenantInvitations so deletes are permanent
      paranoid: false,
    },
  );

  tenantInvitation.associate = (models) => {
    tenantInvitation.belongsTo(models.tenant, {
      foreignKey: {
        allowNull: false,
      },
    });
  };

  return tenantInvitation;
}
