import { Sequelize } from 'sequelize';

export default function (sequelize, DataTypes) {
  const Route = sequelize.define(
    'route',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      continuous: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      windowStart: { type: DataTypes.DATE, allowNull: true },
      windowEnd: { type: DataTypes.DATE, allowNull: true },
      days: { type: DataTypes.JSON, allowNull: true },
      assignedGuard: { type: DataTypes.UUID, allowNull: true },
      vehicleId: { type: DataTypes.UUID, allowNull: true },
      syncHitsBetweenGuards: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      forceVehicleRouteOrder: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      notifyBefore: { type: DataTypes.STRING(32), allowNull: true },
      autoCheckInByGeofence: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      forceCheckInBeforeStart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
    },
    {
      tableName: 'routes',
      timestamps: true,
      paranoid: true,
    },
  );

  Route.associate = function (models: any) {
    Route.hasMany(models.routePoint, { as: 'points', foreignKey: 'routeId' });
  };

  return Route;
}
