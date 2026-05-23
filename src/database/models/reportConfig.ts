import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const reportConfig = sequelize.define(
    'reportConfig',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      defaultFormat: { type: DataTypes.STRING(50), allowNull: true },
      options: { type: DataTypes.JSON, allowNull: true },
    },
    { timestamps: true, paranoid: true },
  );

  reportConfig.associate = (models) => {
    models.reportConfig.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: true } });
    models.reportConfig.belongsTo(models.user, { as: 'createdBy' });
    models.reportConfig.belongsTo(models.user, { as: 'updatedBy' });
  };

  return reportConfig;
}
