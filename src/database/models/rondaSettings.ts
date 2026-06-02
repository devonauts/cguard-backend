import { DataTypes } from 'sequelize';

/**
 * Configuraciones de rondas — patrol configuration for a tenant.
 * A row with postSiteId = null is the tenant-wide default; a row with a
 * postSiteId overrides it for that post site (station group).
 */
export default function (sequelize) {
  const rondaSettings = sequelize.define(
    'rondaSettings',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true, // null = tenant-wide default
      },
      // Cadence / best practices
      frequencyMinutes: {
        type: DataTypes.INTEGER, // how often a round should occur
        allowNull: false,
        defaultValue: 60,
      },
      roundsPerShift: {
        type: DataTypes.INTEGER, // how many rounds expected per shift
        allowNull: true,
      },
      graceMinutes: {
        type: DataTypes.INTEGER, // late tolerance before a round is "late"
        allowNull: false,
        defaultValue: 10,
      },
      maxDurationMinutes: {
        type: DataTypes.INTEGER, // max time to complete a round
        allowNull: false,
        defaultValue: 60,
      },
      // Checkpoint validation requirements
      requirePhoto: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      requireGeofence: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      geofenceRadius: {
        type: DataTypes.INTEGER, // meters
        allowNull: false,
        defaultValue: 50,
      },
      requireNote: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Notifications
      notifyTenantOnStart: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      notifyTenantOnComplete: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      notifyTenantOnMissed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      notifyClient: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        {
          unique: true,
          fields: ['tenantId', 'postSiteId'],
          where: { deletedAt: null },
        },
      ],
    },
  );

  rondaSettings.associate = (models) => {
    rondaSettings.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    rondaSettings.belongsTo(models.businessInfo, {
      as: 'postSite',
      foreignKey: 'postSiteId',
      constraints: false,
    });
    rondaSettings.belongsTo(models.user, { as: 'createdBy' });
    rondaSettings.belongsTo(models.user, { as: 'updatedBy' });
  };

  return rondaSettings;
}
