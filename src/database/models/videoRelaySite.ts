import { DataTypes } from 'sequelize';

/**
 * A remote site that pushes its camera streams INTO the cloud (for DVRs behind NAT
 * in another network/country that the server can't reach directly). The site runs a
 * small relay (generated docker-compose) that authenticates with `publishToken` and
 * publishes each channel to the cloud ingest under `relay/<siteKey>/chN`; go2rtc then
 * pulls those locally and serves them through the normal video pipeline.
 *
 * `publishToken` is stored ENCRYPTED at rest (lib/secretBox) and never returned by
 * the API (masked → configured/last4), like radioDevice's SIP password.
 */
export default function (sequelize) {
  const videoRelaySite = sequelize.define(
    'videoRelaySite',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING(160), allowNull: false },
      // Short stable slug used in the cloud ingest path: relay/<siteKey>/chN
      siteKey: { type: DataTypes.STRING(64), allowNull: false },
      // Encrypted publish credential the site relay presents to the cloud ingest.
      publishToken: { type: DataTypes.STRING(512), allowNull: true },
      ingestProtocol: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'rtmps' }, // rtmps|srt
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unknown' }, // unknown|publishing|offline
      lastSeenAt: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  videoRelaySite.associate = (models) => {
    videoRelaySite.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false } });
    videoRelaySite.hasMany(models.videoDevice, { as: 'devices', foreignKey: 'relaySiteId' });
  };

  return videoRelaySite;
}
