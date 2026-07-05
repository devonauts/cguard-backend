import { DataTypes } from 'sequelize';

/**
 * A supervisor's work shift (clock-in / clock-out) for the supervisor mobile
 * app. Deliberately minimal — no station geofence, no break tracking. One open
 * row per supervisor at a time (punchOutTime === null while on the clock).
 */
export default function (sequelize) {
  const supervisorShift = sequelize.define(
    'supervisorShift',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      punchInTime: { type: DataTypes.DATE, allowNull: false },
      punchInLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchInLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutTime: { type: DataTypes.DATE, allowNull: true },
      punchOutLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      observations: { type: DataTypes.TEXT, allowNull: true },
      // ── Turno enforcement (Phase 2) — the scheduled window this punch is for,
      //    stamped at clock-in from the supervisor's turno config. Lets us
      //    measure punctuality and force-close an overrun shift.
      scheduledStart: { type: DataTypes.DATE, allowNull: true },
      scheduledEnd: { type: DataTypes.DATE, allowNull: true },
      shiftKind: { type: DataTypes.STRING(16), allowNull: true }, // Diurno | Nocturno | 24h
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'on_time' }, // on_time | late | no_schedule
      lateMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      forcedClockOut: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'supervisorShifts', timestamps: true, paranoid: true },
  );

  supervisorShift.associate = (models) => {
    supervisorShift.belongsTo(models.tenant, { as: 'tenant', foreignKey: { name: 'tenantId', allowNull: false } });
    supervisorShift.belongsTo(models.user, { as: 'supervisor', constraints: false, foreignKey: { name: 'supervisorUserId' } });

    // Optional selfie captured at clock-in — polymorphic file relation.
    supervisorShift.hasMany(models.file, {
      as: 'selfie',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: { belongsTo: supervisorShift.getTableName(), belongsToColumn: 'selfie' },
    });
  };

  return supervisorShift;
}
