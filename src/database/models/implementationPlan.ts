import { DataTypes } from 'sequelize';

/**
 * The roll-out record created when a scheduleProposal is PUBLISHED (req 7): a
 * per-guard diff of what changed, plus the notification status. One plan per
 * published proposal; its `implementationPlanItem` rows hold each affected
 * guard's changes and whether they were notified.
 */
export default function (sequelize) {
  const implementationPlan = sequelize.define(
    'implementationPlan',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      proposalId: { type: DataTypes.UUID, allowNull: false },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending', // pending | notified | partial | failed
      },
      totalGuards: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      notifiedGuards: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      publishedById: { type: DataTypes.UUID, allowNull: true },
      importHash: { type: DataTypes.STRING(255), allowNull: true, validate: { len: [0, 255] } },
    },
    {
      indexes: [
        { fields: ['tenantId', 'proposalId'] },
        { unique: true, fields: ['importHash', 'tenantId'], where: { deletedAt: null } },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  implementationPlan.associate = (models) => {
    models.implementationPlan.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
      onDelete: 'CASCADE',
    });
    models.implementationPlan.belongsTo(models.scheduleProposal, {
      as: 'proposal',
      foreignKey: 'proposalId',
      constraints: false,
    });
    models.implementationPlan.hasMany(models.implementationPlanItem, {
      as: 'items',
      foreignKey: 'planId',
      constraints: false,
    });
  };

  return implementationPlan;
}
