import { DataTypes } from 'sequelize';

/**
 * Station "consigna específica" — a recurring standing order/requirement for a
 * station (e.g. "open the public restrooms at 09:00"). Guards complete these as
 * recurring tasks. Recurrence is expressed by `recurrence` + `days`/`dayOfMonth`
 * + `time`, so the worker app can materialise occurrences per day.
 */
export default function (sequelize) {
  const stationOrder = sequelize.define(
    'stationOrder',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: { notEmpty: true, len: [1, 255] },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Time of day the requirement must be done, "HH:mm" (optional → any time).
      time: {
        type: DataTypes.STRING(5),
        allowNull: true,
      },
      // daily | weekdays | weekend | weekly | monthly | once
      recurrence: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'daily',
      },
      // weekly: JSON array of weekday numbers [0..6] (0 = Sunday)
      days: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('days');
          if (!raw) return [];
          try { return JSON.parse(raw); } catch { return []; }
        },
        set(this: any, val: any) {
          this.setDataValue('days', val == null ? null : JSON.stringify(val));
        },
      },
      // monthly: day of month [1..31]
      dayOfMonth: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // once: the specific date; also usable as a start date for recurring ones
      date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      // baja | media | alta
      priority: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: 'media',
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  stationOrder.associate = (models) => {
    models.stationOrder.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.stationOrder.belongsTo(models.station, {
      as: 'station',
      constraints: false,
      foreignKey: { name: 'stationId', allowNull: false },
    });
    models.stationOrder.belongsTo(models.businessInfo, {
      as: 'postSite',
      constraints: false,
      foreignKey: { name: 'postSiteId', allowNull: true },
    });
    models.stationOrder.belongsTo(models.user, {
      as: 'createdBy',
      foreignKey: { name: 'createdById' },
    });
    models.stationOrder.belongsTo(models.user, {
      as: 'updatedBy',
      foreignKey: { name: 'updatedById' },
    });
  };

  return stationOrder;
}
