import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const guardShift = sequelize.define(
    'guardShift',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      punchInTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      punchInLatitude: {
        type: DataTypes.DOUBLE,
        allowNull: true,
      },
      punchInLongitude: {
        type: DataTypes.DOUBLE,
        allowNull: true,
      },
      // Geo-stamped clock-in selfie + the resolved address, battery, and the
      // start-shift checklist captured by the guard at their post.
      punchInPhoto: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      punchInAddress: {
        type: DataTypes.STRING(512),
        allowNull: true,
      },
      punchInBattery: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      punchInChecklist: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      shiftSchedule: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: true,
          isIn: [[
            "Diurno",
            "Nocturno"
          ]],
        }
      },
      numberOfPatrolsDuringShift: {
        type: DataTypes.INTEGER,
      },
      numberOfIncidentsDurindShift: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {

        }
      },
      observations: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 500],
          notEmpty: true,
        }
      },
      punchOutTime: {
        type: DataTypes.DATE,
      },
      punchOutLatitude: {
        type: DataTypes.DOUBLE,
        allowNull: true,
      },
      punchOutLongitude: {
        type: DataTypes.DOUBLE,
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,    
        validate: {
          len: [0, 255],
        },    
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },

      // ── Nómina / Time & Attendance ────────────────────────────────────────
      // Link to the scheduled shift this punch fulfills (matched at clock-in by
      // guard + station + time window). Null = unscheduled / walk-up punch.
      shiftId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Snapshot of the scheduled window at punch time (immutable for payroll,
      // even if the schedule later changes).
      scheduledStart: { type: DataTypes.DATE, allowNull: true },
      scheduledEnd: { type: DataTypes.DATE, allowNull: true },
      // Attendance status (primary). Exceptions table holds granular flags.
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'on_time',
      },
      // Computed on clock-out (overnight-safe). Hours + minute breakdowns.
      hoursWorked: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      // Shift summary snapshot (the guard's "last shift" card + CRM reports).
      // Captured at clock-out from tag scans / incidents / GPS fixes. NULL on a
      // shift that predates the snapshot — the last-shift endpoint recomputes
      // those live. See computeShiftMetrics() in attendanceService.
      checkpointsScanned: { type: DataTypes.INTEGER, allowNull: true },
      incidentsLogged: { type: DataTypes.INTEGER, allowNull: true },
      distanceMeters: { type: DataTypes.INTEGER, allowNull: true },
      overtimeMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lateMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      earlyDepartureMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Geofence: distance from station center + outside-radius flags.
      punchInDistanceM: { type: DataTypes.INTEGER, allowNull: true },
      punchOutDistanceM: { type: DataTypes.INTEGER, allowNull: true },
      punchInOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      punchOutOutsideGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Device/browser metadata (JSON text) + IP at each punch.
      deviceInfo: { type: DataTypes.TEXT, allowNull: true },
      punchInIp: { type: DataTypes.STRING(64), allowNull: true },
      punchOutIp: { type: DataTypes.STRING(64), allowNull: true },
      // Clock-out selfie symmetry (optional).
      punchOutPhoto: { type: DataTypes.TEXT, allowNull: true },
      punchOutAddress: { type: DataTypes.STRING(512), allowNull: true },
      punchOutBattery: { type: DataTypes.INTEGER, allowNull: true },
      // Approval workflow on the record itself.
      approvalStatus: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'none', // none | pending | approved | rejected
      },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      approvalNotes: { type: DataTypes.TEXT, allowNull: true },
      // Payroll period lock: once a period is closed, the record is read-only.
      locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lockedAt: { type: DataTypes.DATE, allowNull: true },
      // One record per shift/day that ACCUMULATES every clock in/out pair, so a
      // guard who clocks out then back in doesn't create a duplicate row. Each
      // session: { in, inLat, inLng, inPhoto, inAddress, inBattery, inDistanceM,
      //            out, outLat, outLng, outDistanceM }. Top-level punchInTime =
      // first session.in, punchOutTime = last session.out (null while open);
      // hoursWorked = sum of (out-in) across sessions.
      sessions: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('sessions');
          if (!raw) return [];
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        },
        set(this: any, val: any) {
          this.setDataValue('sessions', val == null ? null : JSON.stringify(val));
        },
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['importHash', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
        // Hot path: the "active record" lookup
        // (guardNameId + punchOutTime IS NULL) used by guardMe (polled),
        // clock-out, and the clock-out-request endpoints.
        {
          name: 'idx_guardshift_active',
          fields: ['tenantId', 'guardNameId', 'punchOutTime'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  guardShift.associate = (models) => {
    models.guardShift.belongsTo(models.station, {
      as: 'stationName',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardShift.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardShift.belongsTo(models.inventoryHistory, {
      as: 'completeInventoryCheck',
      constraints: false,
    });

    models.guardShift.belongsToMany(models.patrolLog, {
      as: 'patrolsDone',
      constraints: false,
      through: 'guardShiftPatrolsDonePatrolLog',
    });

    models.guardShift.belongsToMany(models.incident, {
      as: 'dailyIncidents',
      constraints: false,
      through: 'guardShiftDailyIncidentsIncident',
    });


    
    models.guardShift.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardShift.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
    });

    // Scheduled shift this punch fulfills (Nómina).
    models.guardShift.belongsTo(models.shift, {
      as: 'scheduledShift',
      foreignKey: 'shiftId',
      constraints: false,
    });

    // Who approved/rejected this attendance record (Nómina).
    models.guardShift.belongsTo(models.user, {
      as: 'approvedBy',
      foreignKey: 'approvedById',
      constraints: false,
    });

    models.guardShift.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.guardShift.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return guardShift;
}
