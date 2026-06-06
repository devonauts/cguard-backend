import { DataTypes } from 'sequelize';

/**
 * Attendance exception — a flagged deviation in a guard's attendance (late,
 * no-show, missed clock-out, outside geofence, early departure, overtime, or a
 * pending manual correction). Created by the clock endpoints and the detection
 * job; resolved/approved by supervisors. Tenant-scoped, audited, paranoid.
 *
 * Dedupe: at most one OPEN exception per (shiftId, type) — enforced in the
 * service/job by find-then-create, not a DB unique (shiftId is nullable for
 * no-shows that may have no punch).
 */
export default function (sequelize) {
  const attendanceException = sequelize.define(
    'attendanceException',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // late_arrival | early_departure | missed_clockin | missed_clockout |
      // no_call_no_show | outside_geofence | overtime | correction_pending
      type: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      severity: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'medium', // low | medium | high | critical
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'open', // open | acknowledged | resolved | approved | rejected
      },
      reason: { type: DataTypes.TEXT, allowNull: true },
      resolutionNotes: { type: DataTypes.TEXT, allowNull: true },
      detectedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      resolvedAt: { type: DataTypes.DATE, allowNull: true },
      // Arbitrary context (distance, minutesLate, scheduledStart, etc.) as JSON.
      meta: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('meta');
          if (!raw) return {};
          if (typeof raw !== 'string') return raw;
          try { return JSON.parse(raw); } catch { return {}; }
        },
        set(this: any, val: any) {
          this.setDataValue('meta', val == null ? null : typeof val === 'string' ? val : JSON.stringify(val));
        },
      },
      // Denormalized FKs for fast filtering (also available via guardShift).
      stationId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  attendanceException.associate = (models) => {
    // The punch this exception belongs to (nullable for pure no-shows).
    models.attendanceException.belongsTo(models.guardShift, {
      as: 'guardShift',
      foreignKey: 'guardShiftId',
      constraints: false,
    });
    // The scheduled shift it relates to.
    models.attendanceException.belongsTo(models.shift, {
      as: 'shift',
      foreignKey: 'shiftId',
      constraints: false,
    });
    // The guard (securityGuard record).
    models.attendanceException.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });
    models.attendanceException.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });
    models.attendanceException.belongsTo(models.user, {
      as: 'resolvedBy',
      foreignKey: 'resolvedById',
      constraints: false,
    });

    models.attendanceException.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.attendanceException.belongsTo(models.user, { as: 'createdBy' });
    models.attendanceException.belongsTo(models.user, { as: 'updatedBy' });
  };

  return attendanceException;
}
