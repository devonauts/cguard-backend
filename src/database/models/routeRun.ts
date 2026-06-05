import { DataTypes } from 'sequelize';

/**
 * A daily "run" of a vehicle-patrol route — tracks whether the route the
 * supervisor must follow was completed on a given day. One row per (route, day).
 */
export default function (sequelize) {
  const routeRun = sequelize.define(
    'routeRun',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      // pending | completed | skipped
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'completed' },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      note: { type: DataTypes.TEXT, allowNull: true },
      completedByName: { type: DataTypes.STRING(255), allowNull: true },
    },
    { timestamps: true, paranoid: true },
  );

  routeRun.associate = (models) => {
    routeRun.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false } });
    routeRun.belongsTo(models.route, { as: 'route', constraints: false, foreignKey: { name: 'routeId', allowNull: false } });
    routeRun.belongsTo(models.user, { as: 'completedBy', foreignKey: { name: 'completedById' } });
  };

  return routeRun;
}
