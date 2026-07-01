import { Sequelize } from 'sequelize';

export default function (sequelize, DataTypes) {
  const RoutePoint = sequelize.define(
    'routePoint',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      routeId: { type: DataTypes.UUID, allowNull: false },
      siteId: { type: DataTypes.UUID, allowNull: false },
      order: { type: DataTypes.INTEGER, allowNull: false },
      duration: { type: DataTypes.INTEGER, allowNull: true },
      scheduledHits: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
      address: { type: DataTypes.TEXT, allowNull: true },
      lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      // What kind of record `siteId` points at, driving coordinate/name
      // resolution: station | businessInfo | client | guard | alarm.
      siteType: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'station' },
      // Per-stop checklist definition — array of { id, label }.
      tasks: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'route_points',
      timestamps: true,
    },
  );

  RoutePoint.associate = function (models: any) {
    RoutePoint.belongsTo(models.route, { as: 'route', foreignKey: 'routeId' });
  };

  return RoutePoint;
}
