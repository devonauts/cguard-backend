import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const reportTemplate = sequelize.define(
    'reportTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(150), allowNull: false },
      description: { type: DataTypes.STRING(255), allowNull: true },
      content: { type: DataTypes.JSON, allowNull: true },
      isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { timestamps: true, paranoid: true },
  );

  reportTemplate.associate = (models) => {
    models.reportTemplate.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: true } });
    models.reportTemplate.belongsTo(models.user, { as: 'createdBy' });
    models.reportTemplate.belongsTo(models.user, { as: 'updatedBy' });
  };

  return reportTemplate;
}
