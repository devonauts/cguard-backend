import { DataTypes } from 'sequelize';

/**
 * One radio-check roll-call run. `mode` is manual (a dispatcher pressed start) or
 * auto (the scheduler fired). Denormalized counters drive the dispatch console /
 * draggable widget without re-aggregating entries. The DB is the source of truth.
 */
export default function (sequelize) {
  const radioCheckSession = sequelize.define(
    'radioCheckSession',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' },
      initiatedByUserId: { type: DataTypes.UUID, allowNull: true },
      scope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'all' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'running' },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      summary: { type: DataTypes.TEXT, allowNull: true },
      summaryAudioUrl: { type: DataTypes.TEXT, allowNull: true },
      summaryStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      totalStations: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      respondedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      noResponseCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      incidentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      indexes: [{ fields: ['tenantId', 'status', 'startedAt'] }],
      timestamps: true,
      paranoid: true,
    },
  );

  radioCheckSession.associate = (models) => {
    models.radioCheckSession.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
    models.radioCheckSession.belongsTo(models.user, { as: 'initiatedBy', foreignKey: 'initiatedByUserId', constraints: false });
    models.radioCheckSession.hasMany(models.radioCheckEntry, { as: 'entries', foreignKey: 'sessionId', constraints: false });
  };

  return radioCheckSession;
}
