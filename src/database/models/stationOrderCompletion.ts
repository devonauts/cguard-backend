import { DataTypes } from 'sequelize';

/**
 * A guard's completion of a station "consigna" occurrence — the activity-log
 * record. Carries the evidence: a note plus photo(s), an optional video and an
 * optional audio voice-note (all stored as file descriptors / URLs).
 */
export default function (sequelize) {
  const stationOrderCompletion = sequelize.define(
    'stationOrderCompletion',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // The occurrence date this completion belongs to (one per order per day).
      occurrenceDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // JSON array of photo descriptors (privateUrl/fileToken …)
      photos: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('photos');
          if (!raw) return [];
          try { return JSON.parse(raw); } catch { return []; }
        },
        set(this: any, val: any) {
          this.setDataValue('photos', val == null ? null : JSON.stringify(val));
        },
      },
      videoUrl: { type: DataTypes.TEXT, allowNull: true },
      audioUrl: { type: DataTypes.TEXT, allowNull: true },
      // who/where (denormalised for the activity log)
      guardName: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  stationOrderCompletion.associate = (models) => {
    models.stationOrderCompletion.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false } });
    models.stationOrderCompletion.belongsTo(models.stationOrder, { as: 'order', constraints: false, foreignKey: { name: 'stationOrderId', allowNull: false } });
    models.stationOrderCompletion.belongsTo(models.station, { as: 'station', constraints: false, foreignKey: { name: 'stationId', allowNull: true } });
    models.stationOrderCompletion.belongsTo(models.securityGuard, { as: 'guard', constraints: false, foreignKey: { name: 'securityGuardId', allowNull: true } });
    models.stationOrderCompletion.belongsTo(models.user, { as: 'createdBy', foreignKey: { name: 'createdById' } });
  };

  return stationOrderCompletion;
}
