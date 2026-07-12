import { DataTypes } from 'sequelize';

/**
 * locationPing — an append-only GPS breadcrumb.
 *
 * The live-telemetry endpoints (guard/me/location, supervisor/me/location) only
 * OVERWRITE a single last-known position (guardShift.live* / supervisorProfile
 * lat-lng), so the CRM map shows one dot and the actual route walked is lost.
 * This table records every ping so the CRM can draw the real trail (polyline)
 * and audit where a guard/supervisor actually went during a shift.
 *
 * Append-only: no updatedAt, never mutated. Rows are cheap; a retention sweep
 * (delete older than N days) keeps the table bounded — see the location trail
 * cleanup job. Queried by (tenantId, securityGuardId|userId, recordedAt).
 */
export default function (sequelize) {
  const locationPing = sequelize.define(
    'locationPing',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // 'guard' | 'supervisor' — which app produced the ping.
      subjectType: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'guard',
      },
      // The tenantUser (user) who pinged — always set.
      userId: { type: DataTypes.UUID, allowNull: true },
      // The securityGuard profile id (guard pings only) — the CRM keys the
      // guard trail on this.
      securityGuardId: { type: DataTypes.UUID, allowNull: true },
      // The open shift at ping time, when cheaply known.
      guardShiftId: { type: DataTypes.UUID, allowNull: true },
      latitude: { type: DataTypes.DOUBLE, allowNull: false },
      longitude: { type: DataTypes.DOUBLE, allowNull: false },
      accuracy: { type: DataTypes.FLOAT, allowNull: true },
      speed: { type: DataTypes.FLOAT, allowNull: true },
      heading: { type: DataTypes.FLOAT, allowNull: true },
      battery: { type: DataTypes.INTEGER, allowNull: true },
      // Client-reported fix time when supplied, else server receipt time.
      recordedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      timestamps: true,
      updatedAt: false, // append-only
      indexes: [
        { fields: ['tenantId', 'securityGuardId', 'recordedAt'] },
        { fields: ['tenantId', 'userId', 'recordedAt'] },
        { fields: ['guardShiftId'] },
      ],
    },
  );

  locationPing.associate = (models) => {
    locationPing.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    locationPing.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: true },
      constraints: false,
    });
  };

  return locationPing;
}
