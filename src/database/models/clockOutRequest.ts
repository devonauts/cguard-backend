import { DataTypes } from 'sequelize';

/**
 * A guard's request to clock out EARLY (more than the Nómina early-clockout
 * threshold before the scheduled end). A supervisor approves/rejects it in the
 * CRM; on approval the guard gets a push + email and the app unlocks the
 * clock-out button. Mirrors the timeOffRequest / shiftExchangeRequest pattern.
 */
export default function (sequelize) {
  const clockOutRequest = sequelize.define(
    'clockOutRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      requestedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      // Snapshot of the shift end at request time (so the queue shows context
      // even if the schedule later changes).
      scheduledEnd: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      decidedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      decisionNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId', 'status'] },
        { fields: ['tenantId', 'guardId', 'status'] },
        { fields: ['tenantId', 'guardShiftId'] },
      ],
    },
  );

  clockOutRequest.associate = (models) => {
    clockOutRequest.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    // The requesting guard (user id — matches shift.guardId / currentUser.id).
    clockOutRequest.belongsTo(models.user, {
      as: 'guardUser',
      foreignKey: { name: 'guardId', allowNull: false },
      constraints: false,
    });
    clockOutRequest.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: true },
      constraints: false,
    });
    clockOutRequest.belongsTo(models.guardShift, {
      as: 'guardShift',
      foreignKey: { name: 'guardShiftId', allowNull: true },
      constraints: false,
    });
    clockOutRequest.belongsTo(models.shift, {
      as: 'shift',
      foreignKey: { name: 'shiftId', allowNull: true },
      constraints: false,
    });
    clockOutRequest.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: true },
      constraints: false,
    });
    clockOutRequest.belongsTo(models.user, {
      as: 'decidedBy',
      foreignKey: { name: 'decidedById', allowNull: true },
      constraints: false,
    });
    clockOutRequest.belongsTo(models.user, { as: 'createdBy' });
    clockOutRequest.belongsTo(models.user, { as: 'updatedBy' });
  };

  return clockOutRequest;
}
