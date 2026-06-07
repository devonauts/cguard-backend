import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const actionPlan = sequelize.define(
    'actionPlan',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      // null = tenant default plan.
      alarmPanelId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      appliesToCategory: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      // array of { order, type, detail }; type =
      // verify|call|video|dispatch_guard|notify_police|notify_customer|note
      steps: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
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

  actionPlan.associate = (models) => {
    actionPlan.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
  };

  return actionPlan;
}
