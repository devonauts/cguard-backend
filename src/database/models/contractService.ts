import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const contractService = sequelize.define(
    'contractService',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      serviceKey: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: 'custom',
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
        validate: { len: [0, 120], notEmpty: true },
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: { len: [0, 255] },
      },
      unit: {
        type: DataTypes.STRING(40),
        allowNull: true,
        validate: { len: [0, 40] },
      },
      contractedQty: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      slaTarget: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  contractService.associate = (models) => {
    models.contractService.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.contractService.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
    });
    models.contractService.belongsTo(models.user, { as: 'createdBy' });
    models.contractService.belongsTo(models.user, { as: 'updatedBy' });
  };

  return contractService;
}
