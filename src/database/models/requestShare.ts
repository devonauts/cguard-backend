export default function (sequelize, DataTypes) {
  const requestShare = sequelize.define(
    'requestShare',
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
      paranoid: false,
    },
  );

  requestShare.associate = (models) => {
    requestShare.belongsTo(models.tenant, {
      foreignKey: {
        allowNull: false,
      },
    });
    requestShare.belongsTo(models.request, {
      foreignKey: {
        allowNull: false,
      },
    });
  };

  return requestShare;
}
