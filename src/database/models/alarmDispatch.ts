import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const alarmDispatch = sequelize.define(
    'alarmDispatch',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      alarmCaseId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      target: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        defaultValue: 'requested',
      },
      eta: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      outcome: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      dispatchedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  alarmDispatch.associate = (models) => {
    alarmDispatch.belongsTo(models.alarmCase, { as: 'case', foreignKey: 'alarmCaseId' });
  };

  return alarmDispatch;
}
