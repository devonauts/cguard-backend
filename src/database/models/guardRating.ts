import { DataTypes } from 'sequelize';

/**
 * guardRating — a customer's 1–5 rating + optional feedback for a guard who is/was
 * on shift at one of the customer's stations. Written exclusively from the client
 * app (POST /customer/guards/:guardId/rating); read by the CRM so the company sees
 * client feedback per guard.
 *
 * `guardId` references securityGuard.id (the securityGuard PK) — the same column
 * guardShift.guardNameId / incident.guardNameId FK to, so shift verification and
 * CRM joins line up. (securityGuard.guardId is the linked user id; we key on the
 * securityGuard PK here for consistency with shift/incident references.)
 */
export default function (sequelize) {
  const guardRating = sequelize.define(
    'guardRating',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'securityGuard.id (PK) of the rated guard',
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      shiftId: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'guardShift.id this rating is associated with (optional)',
      },
      rating: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
          min: 1,
          max: 5,
        },
      },
      comment: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      indexes: [
        { fields: ['tenantId', 'guardId'] },
        { fields: ['tenantId', 'clientAccountId'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  guardRating.associate = (models) => {
    models.guardRating.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });

    models.guardRating.belongsTo(models.clientAccount, {
      as: 'client',
      foreignKey: 'clientAccountId',
      constraints: false,
    });

    models.guardRating.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.guardRating.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.guardRating.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.guardRating.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return guardRating;
}
