import { DataTypes } from 'sequelize';

/**
 * One affected guard's slice of an implementationPlan: how many shifts were
 * added/removed/changed for them, and whether/how they were notified.
 */
export default function (sequelize) {
  const implementationPlanItem = sequelize.define(
    'implementationPlanItem',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      planId: { type: DataTypes.UUID, allowNull: false },
      guardId: { type: DataTypes.UUID, allowNull: false },
      added: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      removed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      changed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // A small sample of the changes for the plan view (not the full year).
      details: { type: DataTypes.JSON, allowNull: true },
      notifyStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending', // pending | sent | failed | skipped
      },
      // Which channels actually delivered: { push, inApp, email }.
      channels: { type: DataTypes.JSON, allowNull: true },
      notifiedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      indexes: [
        { fields: ['tenantId', 'planId'] },
        { fields: ['planId', 'guardId'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  implementationPlanItem.associate = (models) => {
    models.implementationPlanItem.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
      onDelete: 'CASCADE',
    });
    models.implementationPlanItem.belongsTo(models.implementationPlan, {
      as: 'plan',
      foreignKey: 'planId',
      constraints: false,
    });
    models.implementationPlanItem.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });
  };

  return implementationPlanItem;
}
