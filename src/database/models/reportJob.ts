import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const reportJob = sequelize.define(
    'reportJob',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      type: {
        type: DataTypes.STRING(50),
      },
      params: {
        type: DataTypes.JSON,
      },
      status: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'pending',
      },
      resultUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  reportJob.associate = (models) => {
    models.reportJob.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: true } });
    models.reportJob.belongsTo(models.user, { as: 'createdBy' });
    models.reportJob.belongsTo(models.user, { as: 'updatedBy' });
  };

  return reportJob;
}
