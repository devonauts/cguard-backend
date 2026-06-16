import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const shift = sequelize.define(
    'shift',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      startTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      endTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      // True once startTime/endTime are stored as true UTC (tenant-tz aware).
      // New shifts are created correct; the one-time backfill flips legacy rows.
      tzFixed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      // Offset keys whose pre-shift push reminder has already been sent
      // (e.g. ["2d","1d","12h","1h","10m"]). Dedupes the reminder scheduler.
      remindersSent: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,    
        validate: {
          len: [0, 255],
        },    
      },
      tenantUserId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      siteTours: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      tasks: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      postOrders: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      checklists: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      skillSet: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
      },
      department: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Link back to the source guardAssignment + position. These columns exist
      // in the DB (added by the scheduling migration) but were never declared on
      // the model, so Sequelize silently dropped them on insert — leaving shifts
      // unlinked from their assignment. Declaring them makes the linkage persist
      // (required for idempotent regeneration and cascade delete).
      guardAssignmentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      positionId: {
        type: DataTypes.UUID,
        allowNull: true,
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
        {
          // One shift per (guard, station, start, end) — blocks duplicate
          // generation. Generation hard-deletes (force) before recreating, so
          // soft-deleted rows never linger to block a re-create.
          unique: true,
          name: 'uniq_shift_slot',
          fields: ['tenantId', 'guardId', 'stationId', 'startTime', 'endTime'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  shift.associate = (models) => {
    models.shift.belongsTo(models.station, {
      as: 'station',
      constraints: false,
      foreignKey: {
        allowNull: true,
      },
    });

    models.shift.belongsTo(models.user, {
      as: 'guard',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.shift.belongsTo(models.tenantUser, {
      as: 'tenantUser',
      foreignKey: 'tenantUserId',
      constraints: false,
    });


    
    models.shift.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.shift.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
    });

    models.shift.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.shift.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return shift;
}
