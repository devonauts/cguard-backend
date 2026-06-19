import { DataTypes } from 'sequelize';

/**
 * A guard's request for permission to clock in LATE (after the scheduled start
 * plus the station/tenant late-grace window). A supervisor approves/rejects it
 * in the CRM; on approval the guard gets a push + email and the clock-in window
 * gate unlocks for a limited time (expiresAt). The approved request is marked
 * 'used' once the late clock-in actually happens. Mirrors clockOutRequest.
 */
export default function (sequelize) {
  const clockInRequest = sequelize.define(
    'clockInRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Snapshot of the scheduled shift start at request time (so the queue shows
      // context even if the schedule later changes).
      scheduledStart: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM(
          'pending',
          'approved',
          'rejected',
          'cancelled',
          'expired',
          'used',
        ),
        allowNull: false,
        defaultValue: 'pending',
      },
      approvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      decisionNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // After approval, the late clock-in is only allowed until this instant.
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId', 'status'] },
        { fields: ['tenantId', 'guardUserId', 'status'] },
        { fields: ['tenantId', 'stationId', 'status'] },
      ],
    },
  );

  clockInRequest.associate = (models) => {
    clockInRequest.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    // The requesting guard (user id — matches shift.guardId / currentUser.id).
    clockInRequest.belongsTo(models.user, {
      as: 'guardUser',
      foreignKey: { name: 'guardUserId', allowNull: false },
      constraints: false,
    });
    clockInRequest.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'guardId', allowNull: true },
      constraints: false,
    });
    clockInRequest.belongsTo(models.shift, {
      as: 'shift',
      foreignKey: { name: 'shiftId', allowNull: true },
      constraints: false,
    });
    clockInRequest.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: true },
      constraints: false,
    });
    clockInRequest.belongsTo(models.user, {
      as: 'approvedBy',
      foreignKey: { name: 'approvedById', allowNull: true },
      constraints: false,
    });
    clockInRequest.belongsTo(models.user, { as: 'createdBy' });
    clockInRequest.belongsTo(models.user, { as: 'updatedBy' });
  };

  return clockInRequest;
}
