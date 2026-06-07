import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const openCloseSchedule = sequelize.define(
    'openCloseSchedule',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      alarmPanelId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      dayOfWeek: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      openTime: {
        type: DataTypes.STRING(5),
        allowNull: true,
      },
      closeTime: {
        type: DataTypes.STRING(5),
        allowNull: true,
      },
      graceMins: {
        type: DataTypes.INTEGER,
        defaultValue: 15,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  openCloseSchedule.associate = (models) => {
    openCloseSchedule.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
  };

  return openCloseSchedule;
}
