import { DataTypes } from 'sequelize';

/**
 * A supervisor's visit to a single stop (routePoint) of a vehicle-patrol route.
 * One row per (routePoint, run/attempt): records arrival/completion, the
 * per-stop task checklist results, GPS at check-in and the proof photos.
 *
 * Sits alongside routeRun (whole-route completion) but at stop granularity so
 * the mobile supervisor app can drive turn-by-turn stops and prove each hit.
 */
export default function (sequelize) {
  const routePointVisit = sequelize.define(
    'routePointVisit',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      routeId: { type: DataTypes.UUID, allowNull: false },
      routePointId: { type: DataTypes.UUID, allowNull: false },
      // Null when a stop is checked outside a started run (ad-hoc visit).
      runId: { type: DataTypes.UUID, allowNull: true },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      // pending | completed | skipped
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'pending' },
      arrivedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      // Array of { id, label, ok } — the per-stop checklist results.
      taskResults: { type: DataTypes.JSON, allowNull: true },
      latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    },
    {
      tableName: 'route_point_visits',
      timestamps: true,
      paranoid: true,
    },
  );

  routePointVisit.associate = (models) => {
    routePointVisit.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { name: 'tenantId', allowNull: false },
      constraints: false,
    });

    routePointVisit.belongsTo(models.route, {
      as: 'route',
      foreignKey: { name: 'routeId', allowNull: false },
      constraints: false,
    });

    routePointVisit.belongsTo(models.routePoint, {
      as: 'routePoint',
      foreignKey: { name: 'routePointId', allowNull: false },
      constraints: false,
    });

    routePointVisit.belongsTo(models.routeRun, {
      as: 'run',
      foreignKey: { name: 'runId', allowNull: true },
      constraints: false,
    });

    // Proof photos uploaded at the stop check (mirrors task.taskCompletedImage).
    routePointVisit.hasMany(models.file, {
      as: 'proofImages',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.routePointVisit.getTableName(),
        belongsToColumn: 'proofImages',
      },
    });
  };

  return routePointVisit;
}
