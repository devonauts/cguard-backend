import { DataTypes } from 'sequelize';

/**
 * Per-tenant configuration for the recurring radio check (pase de novedades).
 * One row per tenant. `lastAutoRunAt` doubles as the cluster-safe claim column
 * the scheduler uses (atomic conditional UPDATE) so exactly one PM2 worker fires
 * an auto run. `channel` selects the radio channel adapter ('app' now; 'wave_ptx'
 * in Phase 2).
 */
export default function (sequelize) {
  const radioCheckSettings = sequelize.define(
    'radioCheckSettings',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      intervalMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 35 },
      perStationTimeoutSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 180 },
      activeHoursStart: { type: DataTypes.STRING(5), allowNull: true },
      activeHoursEnd: { type: DataTypes.STRING(5), allowNull: true },
      promptText: { type: DataTypes.TEXT, allowNull: true },
      voiceAnnouncement: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      channel: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'app' },
      lastAutoRunAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      indexes: [{ unique: true, fields: ['tenantId'] }],
      timestamps: true,
      paranoid: true,
    },
  );

  radioCheckSettings.associate = (models) => {
    models.radioCheckSettings.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
  };

  return radioCheckSettings;
}
