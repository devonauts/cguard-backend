import { DataTypes } from 'sequelize';

export default function (sequelize) {
  // Immutable record of a raw signal received from a panel/receiver.
  const alarmSignal = sequelize.define(
    'alarmSignal',
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
      accountNumber: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      zoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      partition: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },
      format: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      eventCode: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      qualifier: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },
      raw: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      channel: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      receiverId: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      receivedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
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

  alarmSignal.associate = (models) => {
    alarmSignal.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
  };

  return alarmSignal;
}
