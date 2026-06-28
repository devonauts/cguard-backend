import { DataTypes } from 'sequelize';

/**
 * notificationPreference — per-customer (clientAccount) mute/unmute of a CATEGORY
 * of push notifications for the Mi Seguridad client app. Written/read exclusively
 * from the client app (GET/PUT /customer/notification-preferences). The backend
 * checks these rows in clientNotifyService before sending a customer push and
 * SKIPS the push when a row says enabled=false.
 *
 * Categories mirror the `data.type` values customer pushes already send, grouped:
 *   incidents | messages | coverage | visitors | patrols | support | documents |
 *   digest | sos   (see NOTIFICATION_CATEGORIES below).
 *
 * Default = ENABLED: an absent row means "send" (fail-open). Unique on
 * (clientAccountId, category) so each category has at most one preference row.
 */
export default function (sequelize) {
  const notificationPreference = sequelize.define(
    'notificationPreference',
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
      // Optional: which client-app user toggled it. Not part of the unique key —
      // the preference is per clientAccount, not per device/user.
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      category: {
        type: DataTypes.STRING(40),
        allowNull: false,
        comment: 'One of NOTIFICATION_CATEGORIES',
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['clientAccountId', 'category'],
          where: {
            deletedAt: null,
          },
        },
        { fields: ['tenantId', 'clientAccountId'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  notificationPreference.associate = (models) => {
    models.notificationPreference.belongsTo(models.clientAccount, {
      as: 'clientAccount',
      foreignKey: 'clientAccountId',
      constraints: false,
    });

    models.notificationPreference.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.notificationPreference.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.notificationPreference.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return notificationPreference;
}
