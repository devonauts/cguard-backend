import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const reportFavorite = sequelize.define(
    'reportFavorite',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(150), allowNull: true },
      params: { type: DataTypes.JSON, allowNull: true },
    },
    { timestamps: true, paranoid: true },
  );

  reportFavorite.associate = (models) => {
    models.reportFavorite.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: true } });
    models.reportFavorite.belongsTo(models.user, { as: 'createdBy' });
    models.reportFavorite.belongsTo(models.user, { as: 'updatedBy' });
  };

  return reportFavorite;
}
