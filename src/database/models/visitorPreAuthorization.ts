import { DataTypes } from 'sequelize';

/**
 * A visitor PRE-AUTHORIZATION created by the CUSTOMER app (Mi Seguridad). The
 * customer pre-registers an expected visitor and gets a `qrToken` that their app
 * renders as a QR image. At the gate, the WORKER/guard app scans the QR and POSTs
 * the token to /tenant/:tenantId/visitor-preauth/scan; on a valid scan the guard
 * service marks the pre-auth `used` and materialises a real `visitorLog` row (so
 * the visit appears in Control de Visitas), storing its id in createdVisitorLogId.
 *
 * `qrToken` is a random, unique, opaque string (UUID) — it is the entire QR
 * payload, so the customer app and the guard app agree on a single value. Status
 * lifecycle: active → used (scanned) | revoked (customer cancels) | expired
 * (validUntil passed; enforced at scan time).
 */
export default function (sequelize) {
  const visitorPreAuthorization = sequelize.define(
    'visitorPreAuthorization',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // The customer (clientAccount) that created the pre-auth. Scopes customer reads.
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Resolved target station (the gate/installation the visitor is expected at).
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      visitorFirstName: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      visitorLastName: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      visitorIdNumber: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      company: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      vehiclePlate: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },
      validFrom: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      validUntil: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Opaque, unique QR payload (UUID). The customer app encodes it into a QR
      // image; the guard app sends it back verbatim on scan.
      qrToken: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
      // active | used | expired | revoked
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
      },
      usedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // The guard (securityGuard / user) who scanned & admitted the visitor.
      usedByGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // The visitorLog row materialised from this pre-auth on a successful scan.
      createdVisitorLogId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['qrToken'],
        },
        {
          fields: ['tenantId'],
        },
        {
          fields: ['clientAccountId'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  visitorPreAuthorization.associate = (models) => {
    models.visitorPreAuthorization.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.visitorPreAuthorization.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
      constraints: false,
    });

    models.visitorPreAuthorization.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.visitorPreAuthorization.belongsTo(models.visitorLog, {
      as: 'createdVisitorLog',
      foreignKey: 'createdVisitorLogId',
      constraints: false,
    });

    models.visitorPreAuthorization.belongsTo(models.user, { as: 'createdBy' });
    models.visitorPreAuthorization.belongsTo(models.user, { as: 'updatedBy' });
  };

  return visitorPreAuthorization;
}
