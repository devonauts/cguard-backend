import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const reportSchedule = sequelize.define(
    'reportSchedule',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING(150) },
      cron: { type: DataTypes.STRING(120), allowNull: true },
      params: { type: DataTypes.JSON },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      nextRunAt: { type: DataTypes.DATE, allowNull: true },
      lastRunAt: { type: DataTypes.DATE, allowNull: true },
    },
    { timestamps: true, paranoid: true },
  );

  reportSchedule.associate = (models) => {
    models.reportSchedule.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: true } });
    models.reportSchedule.belongsTo(models.user, { as: 'createdBy' });
    models.reportSchedule.belongsTo(models.user, { as: 'updatedBy' });
  };

  return reportSchedule;
}
