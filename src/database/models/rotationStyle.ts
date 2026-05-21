import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const rotationStyle = sequelize.define(
    'rotationStyle',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'Display name e.g. "3-3-2", "5-2", "4-4-2"',
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // For 24h stations: dayShifts-nightShifts-restDays
      // For 12h stations: workDays-restDays (nightShifts = 0)
      dayShifts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 5,
        comment: 'Number of consecutive day shifts',
      },
      nightShifts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Number of consecutive night shifts (0 for 12h stations)',
      },
      restDays: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 2,
        comment: 'Number of consecutive rest days',
      },
      isSystem: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'System-defined presets cannot be deleted',
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  rotationStyle.associate = (models) => {
    models.rotationStyle.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: true },
      comment: 'null = global system preset',
    });

    models.rotationStyle.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.rotationStyle.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return rotationStyle;
}
