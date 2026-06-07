import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const alarmPanel = sequelize.define(
    'alarmPanel',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      accountNumber: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      protocol: {
        type: DataTypes.STRING(20),
        defaultValue: 'sia-dc09',
      },
      panelType: {
        type: DataTypes.STRING(20),
        defaultValue: 'intrusion',
      },
      make: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      model: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      comms: {
        type: DataTypes.STRING(20),
        defaultValue: 'ip',
      },
      receiverLine: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      // AES key (hex) for DC-09 encrypted accounts. NEVER returned by the API.
      dc09Key: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      supervisionMins: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      testIntervalHrs: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'unknown',
      },
      lastSignalAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      customerId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
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

  alarmPanel.associate = (models) => {
    alarmPanel.hasMany(models.alarmZone, { as: 'zones', foreignKey: 'alarmPanelId' });
    alarmPanel.hasMany(models.alarmContact, { as: 'contacts', foreignKey: 'alarmPanelId' });
  };

  return alarmPanel;
}
