import { DataTypes } from 'sequelize';

/**
 * A supervisor's on-site station inspection (Station Details → Start Inspection):
 * a pass/issues result + notes + a voice note with its transcription + photo/
 * video evidence. Distinct from incidents (novedades) — this is a proactive
 * check, not a reported event.
 */
export default function (sequelize) {
  const stationInspection = sequelize.define(
    'stationInspection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      stationId: { type: DataTypes.UUID, allowNull: false },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      // 'ok' = all clear, 'issues' = problems found.
      result: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ok' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      transcription: { type: DataTypes.TEXT, allowNull: true },
      latitude: { type: DataTypes.DOUBLE, allowNull: true },
      longitude: { type: DataTypes.DOUBLE, allowNull: true },
    },
    { timestamps: true, paranoid: true },
  );

  stationInspection.associate = (models) => {
    stationInspection.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { name: 'tenantId', allowNull: false },
    });
    stationInspection.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: false },
      constraints: false,
    });
    stationInspection.belongsTo(models.user, {
      as: 'supervisor',
      foreignKey: { name: 'supervisorUserId', allowNull: false },
      constraints: false,
    });

    // Photo/video evidence.
    stationInspection.hasMany(models.file, {
      as: 'media',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.stationInspection.getTableName(),
        belongsToColumn: 'media',
      },
    });
    // Voice recording.
    stationInspection.hasMany(models.file, {
      as: 'audio',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.stationInspection.getTableName(),
        belongsToColumn: 'audio',
      },
    });
  };

  return stationInspection;
}
