import { DataTypes } from 'sequelize';

/**
 * A backup/relief event that feeds the "backup availability" factor of the
 * performance score. Guards & supervisors earn points for:
 *   - kind 'volunteer' — offering to cover an open / at-risk shift (small pts)
 *   - kind 'cover'     — actually covering a missed/open shift (larger pts),
 *                        awarded once a supervisor confirms it.
 *
 * `points` is snapshotted when the event is created/confirmed so later changes
 * to the scoring constants don't rewrite history.
 */
export default function (sequelize) {
  const backupEvent = sequelize.define(
    'backupEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      kind: {
        type: DataTypes.ENUM('volunteer', 'cover'),
        allowNull: false,
      },
      eventDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('offered', 'confirmed', 'rejected', 'cancelled'),
        allowNull: false,
        defaultValue: 'offered',
      },
      points: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      subjectType: {
        type: DataTypes.ENUM('guard', 'supervisor'),
        allowNull: false,
        defaultValue: 'guard',
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId', 'subjectUserId', 'eventDate'] },
        { fields: ['tenantId', 'status'] },
      ],
    },
  );

  backupEvent.associate = (models) => {
    backupEvent.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    backupEvent.belongsTo(models.user, {
      as: 'subject',
      foreignKey: { name: 'subjectUserId', allowNull: false },
      constraints: false,
    });
    backupEvent.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: true },
      constraints: false,
    });
    backupEvent.belongsTo(models.shift, {
      as: 'shift',
      foreignKey: { name: 'shiftId', allowNull: true },
      constraints: false,
    });
    backupEvent.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: true },
      constraints: false,
    });
    backupEvent.belongsTo(models.user, {
      as: 'confirmedBy',
      foreignKey: { name: 'confirmedById', allowNull: true },
      constraints: false,
    });
    backupEvent.belongsTo(models.user, { as: 'createdBy' });
    backupEvent.belongsTo(models.user, { as: 'updatedBy' });
  };

  return backupEvent;
}
