import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const contractRenewal = sequelize.define(
    'contractRenewal',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      periodLabel: {
        type: DataTypes.STRING(60),
        allowNull: true,
        validate: { len: [0, 60] },
      },
      fromDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      toDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      durationMonths: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active', // 'active' | 'finished'
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  contractRenewal.associate = (models) => {
    models.contractRenewal.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.contractRenewal.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
    });
    models.contractRenewal.belongsTo(models.user, { as: 'createdBy' });
    models.contractRenewal.belongsTo(models.user, { as: 'updatedBy' });
  };

  return contractRenewal;
}
