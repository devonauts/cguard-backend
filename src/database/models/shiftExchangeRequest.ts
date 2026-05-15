import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const shiftExchangeRequest = sequelize.define(
    'shiftExchangeRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      requestDate: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      fromShiftId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      toShiftId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      fromGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      toGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  shiftExchangeRequest.associate = (models) => {
    models.shiftExchangeRequest.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.shiftExchangeRequest.belongsTo(models.user, {
      as: 'fromGuard',
      foreignKey: 'fromGuardId',
      constraints: false,
    });

    models.shiftExchangeRequest.belongsTo(models.user, {
      as: 'toGuard',
      foreignKey: 'toGuardId',
      constraints: false,
    });

    models.shiftExchangeRequest.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.shiftExchangeRequest.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return shiftExchangeRequest;
}
