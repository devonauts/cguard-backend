import { DataTypes } from 'sequelize';

/**
 * IP radio (RoIP / SIP gateway) registered by a tenant so the app PTT channel can
 * bridge to physical radios. Connection settings live here; the SIP password is
 * stored ENCRYPTED at rest (lib/secretBox) and never returned by the API.
 * Mirrors the videoDevice/alarmPanel device pattern. The cguard-sip-bridge process
 * reads the active rows, registers to each gateway, and relays audio to/from the
 * tenant voice room (see lib/radioVoice + services/radio/sipBridgeControl).
 */
export default function (sequelize) {
  const radioDevice = sequelize.define(
    'radioDevice',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING(160), allowNull: false },

      // ── SIP connection ──────────────────────────────────────────────────────
      host: { type: DataTypes.STRING(160), allowNull: true },
      sipPort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5060 },
      transport: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'udp' }, // udp|tcp|tls
      sipUsername: { type: DataTypes.STRING(120), allowNull: true },
      // AES-256-GCM envelope from lib/secretBox.encrypt(); NEVER returned by the API.
      sipPassword: { type: DataTypes.STRING(512), allowNull: true },
      sipDomain: { type: DataTypes.STRING(160), allowNull: true }, // registrar/domain (defaults to host)
      registerRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

      // ── Radio/audio ─────────────────────────────────────────────────────────
      extension: { type: DataTypes.STRING(80), allowNull: true }, // extension/talkgroup to bridge
      codec: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pcmu' }, // G.711 µ-law
      rtpPortStart: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16000 },
      rtpPortEnd: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16100 },

      // ── State (written by the bridge process) ────────────────────────────────
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unknown' }, // unknown|registered|offline|error
      lastSeenAt: { type: DataTypes.DATE, allowNull: true },
      lastError: { type: DataTypes.TEXT, allowNull: true },

      // ── Org context ──────────────────────────────────────────────────────────
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

      importHash: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  radioDevice.associate = (models) => {
    models.radioDevice.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.radioDevice.belongsTo(models.user, { as: 'createdBy' });
    models.radioDevice.belongsTo(models.user, { as: 'updatedBy' });
  };

  return radioDevice;
}
