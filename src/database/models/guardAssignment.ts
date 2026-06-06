import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const guardAssignment = sequelize.define(
    'guardAssignment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'User ID of the security guard',
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // 'rotation' = driven by a station position + rotation style (Horario).
      // 'adhoc'    = a manual one-off assignment with an explicit time window
      //              (post-site / guard-profile screens). Both are the single
      //              source of truth — shifts are always generated from here.
      kind: {
        type: DataTypes.ENUM('rotation', 'adhoc'),
        allowNull: false,
        defaultValue: 'rotation',
      },
      positionId: {
        type: DataTypes.UUID,
        allowNull: true, // null for kind='adhoc'
        comment: 'The station position this guard fills (rotation only)',
      },
      rotationStyleId: {
        type: DataTypes.UUID,
        allowNull: true, // null for kind='adhoc'
      },
      // Explicit HH:mm window for ad-hoc assignments (no position to inherit from).
      startTime: {
        type: DataTypes.STRING(5),
        allowNull: true,
        comment: "HH:mm shift start for kind='adhoc'",
      },
      endTime: {
        type: DataTypes.STRING(5),
        allowNull: true,
        comment: "HH:mm shift end for kind='adhoc'",
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: 'When this rotation assignment begins',
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: 'When this assignment ends (null = indefinite)',
      },
      platoonOffset: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Offset in days from rotation start to stagger platoons',
      },
      isRelief: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'True if this is a sacafranco/floating relief guard',
      },
      coveredStationIds: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'JSON array of station IDs this sacafranco covers (e.g. ["id1","id2"])',
        get(this: any) {
          const raw = this.getDataValue('coveredStationIds');
          if (!raw) return [];
          try { return JSON.parse(raw); } catch { return []; }
        },
        set(this: any, val: any) {
          this.setDataValue('coveredStationIds', val ? JSON.stringify(val) : null);
        },
      },
      status: {
        type: DataTypes.ENUM('active', 'paused', 'ended'),
        allowNull: false,
        defaultValue: 'active',
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['guardId', 'stationId'] },
        { fields: ['positionId'] },
        { fields: ['status'] },
      ],
    },
  );

  guardAssignment.associate = (models) => {
    models.guardAssignment.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.stationPosition, {
      as: 'position',
      foreignKey: 'positionId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.rotationStyle, {
      as: 'rotationStyle',
      foreignKey: 'rotationStyleId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.guardAssignment.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.guardAssignment.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return guardAssignment;
}
