import { DataTypes } from 'sequelize';

/**
 * One station's leg of a radio-check session. The on-duty guard answers here
 * (voice clip → audioUrl, or a canned "Sin novedad", or free text). guardUserId
 * is the canonical addressing key (users.id) used by pushToUser and matched
 * against req.currentUser.id on the guard reply endpoint; guardSecurityGuardId is
 * denormalized for labels, mirroring the messaging recipient model. The scheduler
 * advances station-by-station using `status` + `timeoutAt`.
 */
export default function (sequelize) {
  const radioCheckEntry = sequelize.define(
    'radioCheckEntry',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      sessionId: { type: DataTypes.UUID, allowNull: false },
      stationId: { type: DataTypes.UUID, allowNull: false },
      guardUserId: { type: DataTypes.UUID, allowNull: true },
      guardSecurityGuardId: { type: DataTypes.UUID, allowNull: true },
      guardName: { type: DataTypes.STRING(200), allowNull: true },
      stationName: { type: DataTypes.STRING(250), allowNull: true },
      seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'pending' },
      promptText: { type: DataTypes.TEXT, allowNull: true },
      promptAudioUrl: { type: DataTypes.TEXT, allowNull: true },
      audioUrl: { type: DataTypes.TEXT, allowNull: true },
      transcript: { type: DataTypes.TEXT, allowNull: true },
      transcriptStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      classification: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'unknown' },
      replyKind: { type: DataTypes.STRING(8), allowNull: true },
      clientMsgId: { type: DataTypes.STRING(64), allowNull: true },
      notifiedAt: { type: DataTypes.DATE, allowNull: true },
      respondedAt: { type: DataTypes.DATE, allowNull: true },
      timeoutAt: { type: DataTypes.DATE, allowNull: true },
      incidentId: { type: DataTypes.UUID, allowNull: true },
    },
    {
      indexes: [
        { fields: ['tenantId', 'sessionId', 'seq'] },
        { fields: ['tenantId', 'guardUserId', 'status'] },
        { fields: ['tenantId', 'status', 'timeoutAt'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  radioCheckEntry.associate = (models) => {
    models.radioCheckEntry.belongsTo(models.tenant, {
      as: 'tenant', foreignKey: { allowNull: false }, onDelete: 'CASCADE',
    });
    models.radioCheckEntry.belongsTo(models.radioCheckSession, { as: 'session', foreignKey: 'sessionId', constraints: false });
    models.radioCheckEntry.belongsTo(models.station, { as: 'station', foreignKey: 'stationId', constraints: false });
    models.radioCheckEntry.belongsTo(models.user, { as: 'guard', foreignKey: 'guardUserId', constraints: false });
    models.radioCheckEntry.belongsTo(models.incident, { as: 'incident', foreignKey: 'incidentId', constraints: false });
  };

  return radioCheckEntry;
}
