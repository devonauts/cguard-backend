import { DataTypes } from 'sequelize';

/**
 * A shift PASSDOWN (pase de turno / relevo): the handover an outgoing guard leaves
 * when they clock out of a post, received automatically by the next guard who clocks
 * in there. The general novedades live in `notes` (+ `passdownImages` photos); each
 * discrete instruction is a `task` (source='passdown', linked via task.passdownId)
 * so it becomes actionable for the incoming guard and visible in the CRM.
 */
export default function (sequelize) {
  const shiftPassdown = sequelize.define(
    'shiftPassdown',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // 'guard' (station-bound, instructions → post-tasks) | 'supervisor'
      // (roaming/tenant-wide handover, instructions stored inline).
      channel: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'guard' },
      // Nullable: a supervisor handover isn't bound to a post.
      stationId: { type: DataTypes.UUID, allowNull: true },
      stationName: { type: DataTypes.STRING(250), allowNull: true },
      // Supervisor instructions (JSON [{taskToDo,priority,wasItDone}]) — supervisors
      // have no post so instructions can't become post-tasks.
      instructionsJson: { type: DataTypes.TEXT, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      // Outgoing (saliente) guard who left the handover.
      outgoingGuardUserId: { type: DataTypes.UUID, allowNull: true },
      outgoingSecurityGuardId: { type: DataTypes.UUID, allowNull: true },
      outgoingGuardName: { type: DataTypes.STRING(200), allowNull: true },
      guardShiftId: { type: DataTypes.UUID, allowNull: true },
      // 'Diurno' | 'Nocturno' (from guardShift.shiftSchedule).
      shiftSchedule: { type: DataTypes.STRING(20), allowNull: true },
      // '24h' | '12h' | 'otro' — derived from the scheduled window length.
      shiftKind: { type: DataTypes.STRING(10), allowNull: true },
      // General handover novedades (free text). "Sin novedad" when nothing to hand over.
      notes: { type: DataTypes.TEXT, allowNull: true },
      instructionCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // 'open' (left, not yet received) | 'received'
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'open' },
      // Incoming (entrante) guard who received it on clock-in.
      receivedByGuardUserId: { type: DataTypes.UUID, allowNull: true },
      receivedByName: { type: DataTypes.STRING(200), allowNull: true },
      receivedByShiftId: { type: DataTypes.UUID, allowNull: true },
      receivedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      indexes: [
        { fields: ['tenantId', 'stationId', 'status'] },
        { fields: ['tenantId', 'status', 'createdAt'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  shiftPassdown.associate = (models) => {
    models.shiftPassdown.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false } });
    models.shiftPassdown.belongsTo(models.station, { as: 'station', constraints: false });
    models.shiftPassdown.belongsTo(models.user, { as: 'outgoingGuard', foreignKey: 'outgoingGuardUserId', constraints: false });
    models.shiftPassdown.belongsTo(models.user, { as: 'receivedByGuard', foreignKey: 'receivedByGuardUserId', constraints: false });

    // Photos attached to the handover.
    models.shiftPassdown.hasMany(models.file, {
      as: 'passdownImages',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.shiftPassdown.getTableName(),
        belongsToColumn: 'passdownImages',
      },
    });

    // The discrete instructions this passdown produced (tasks tagged passdownId).
    models.shiftPassdown.hasMany(models.task, { as: 'instructions', foreignKey: 'passdownId', constraints: false });
  };

  return shiftPassdown;
}
