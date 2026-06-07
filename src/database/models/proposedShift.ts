import { DataTypes } from 'sequelize';

/**
 * One staged shift change belonging to a `scheduleProposal`. This is the diff
 * vs. the live `shift` table — it is NEVER read by the worker-app or any live
 * schedule view. On publish, each row is applied to `shift`:
 *   add    → create a live shift
 *   remove → delete the live shift (targetShiftId)
 *   change → update the live shift (targetShiftId) to these values
 *   keep   → no-op (recorded so the preview can show unchanged days)
 */
export default function (sequelize) {
  const proposedShift = sequelize.define(
    'proposedShift',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      proposalId: { type: DataTypes.UUID, allowNull: false },
      action: {
        type: DataTypes.STRING(10),
        allowNull: false, // add | remove | change | keep
      },
      guardId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      positionId: { type: DataTypes.UUID, allowNull: true },
      guardAssignmentId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      startTime: { type: DataTypes.DATE, allowNull: true },
      endTime: { type: DataTypes.DATE, allowNull: true },
      // The live shift this remove/change refers to (null for add/keep).
      targetShiftId: { type: DataTypes.UUID, allowNull: true },
      // Optional extras: previous guard/time for a change, shift type (D/N), etc.
      meta: { type: DataTypes.JSON, allowNull: true },
    },
    {
      indexes: [
        { fields: ['tenantId', 'proposalId'] },
        { fields: ['proposalId', 'action'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  proposedShift.associate = (models) => {
    models.proposedShift.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
      onDelete: 'CASCADE',
    });
    models.proposedShift.belongsTo(models.scheduleProposal, {
      as: 'proposal',
      foreignKey: 'proposalId',
      constraints: false,
    });
    models.proposedShift.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });
    models.proposedShift.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });
  };

  return proposedShift;
}
