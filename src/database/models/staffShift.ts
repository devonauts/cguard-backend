import { DataTypes } from 'sequelize';

/**
 * An administrative / office user's work shift (clock-in / clock-out), created
 * from the CRM web time clock (Nómina › Reloj de Asistencia). Office staff have
 * no securityGuard row and no station, so they can't use the guard punch — this
 * is their timesheet, folded into Nómina › Registros de Asistencia the same way
 * supervisorShift is (tagged role='administrative').
 *
 * Modeled on supervisorShift (station-less, keyed by a plain userId) plus an
 * OPTIONAL office geofence: if the user has an office location set, the punch
 * distance is validated + recorded; otherwise it's a free-form punch.
 *
 * One open row per user at a time (punchOutTime === null while on the clock).
 */
export default function (sequelize) {
  const staffShift = sequelize.define(
    'staffShift',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      punchInTime: { type: DataTypes.DATE, allowNull: false },
      punchInLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchInLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutTime: { type: DataTypes.DATE, allowNull: true },
      punchOutLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      punchOutLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      observations: { type: DataTypes.TEXT, allowNull: true },
      // Clock-in evidence parity with guard/supervisor punches.
      punchInPhoto: { type: DataTypes.TEXT, allowNull: true },
      punchInAddress: { type: DataTypes.STRING(255), allowNull: true },
      punchInBattery: { type: DataTypes.INTEGER, allowNull: true },
      punchInChecklist: { type: DataTypes.TEXT, allowNull: true },
      punchOutPhoto: { type: DataTypes.TEXT, allowNull: true },
      punchOutAddress: { type: DataTypes.STRING(255), allowNull: true },
      // Break periods: [{ start: ISO, end: ISO|null }]; open last entry = on break.
      breaks: { type: DataTypes.JSON, allowNull: true },
      hoursWorked: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      // Optional office-geofence snapshot at punch time (null when no office set).
      punchInDistanceM: { type: DataTypes.INTEGER, allowNull: true },
      punchOutDistanceM: { type: DataTypes.INTEGER, allowNull: true },
      punchInOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: true },
      punchOutOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'on_time' }, // on_time | late | no_schedule
      lateMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      forcedClockOut: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'staffShifts', timestamps: true, paranoid: true },
  );

  staffShift.associate = (models) => {
    staffShift.belongsTo(models.tenant, { as: 'tenant', foreignKey: { name: 'tenantId', allowNull: false } });
    staffShift.belongsTo(models.user, { as: 'user', constraints: false, foreignKey: { name: 'userId' } });

    staffShift.hasMany(models.file, {
      as: 'selfie',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: { belongsTo: staffShift.getTableName(), belongsToColumn: 'selfie' },
    });
  };

  return staffShift;
}
