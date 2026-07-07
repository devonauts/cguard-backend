/**
 * metricsSnapshot — one row per minute (written by the leader-elected
 * MetricsSnapshot job, see server.ts) rolling up the instantaneous
 * system/pool/slow/error metrics into a time series. This is what turns every
 * previously-instantaneous observability number into a TREND: heap/RSS creep,
 * disk growth, pool saturation, slow-query and error rates over time. Pruned to
 * ~14 days. `createdAt` is the time axis.
 */
export default function (sequelize, DataTypes) {
  const metricsSnapshot = sequelize.define(
    'metricsSnapshot',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      hostMemPct: { type: DataTypes.FLOAT, allowNull: true },
      heapUsedPct: { type: DataTypes.FLOAT, allowNull: true },
      rss: { type: DataTypes.BIGINT, allowNull: true },
      loadPct: { type: DataTypes.FLOAT, allowNull: true },
      diskPct: { type: DataTypes.FLOAT, allowNull: true },
      dbPoolUsing: { type: DataTypes.INTEGER, allowNull: true },
      dbPoolWaiting: { type: DataTypes.INTEGER, allowNull: true },
      dbPoolMax: { type: DataTypes.INTEGER, allowNull: true },
      dbSizeBytes: { type: DataTypes.BIGINT, allowNull: true },
      slowTotal: { type: DataTypes.INTEGER, allowNull: true },
      slowMax: { type: DataTypes.INTEGER, allowNull: true },
      errorCount: { type: DataTypes.INTEGER, allowNull: true },
      jobErrors: { type: DataTypes.INTEGER, allowNull: true },
      extra: { type: DataTypes.JSON, allowNull: true },
    },
    {
      timestamps: true,
      indexes: [{ fields: ['createdAt'] }],
    },
  );
  return metricsSnapshot;
}
