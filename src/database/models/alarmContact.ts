import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const alarmContact = sequelize.define(
    'alarmContact',
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
      name: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      phone: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      email: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      callOrder: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
      },
      // Verbal passcode. NEVER returned by the API.
      passcode: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      authority: {
        type: DataTypes.STRING(20),
        allowNull: true,
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

  alarmContact.associate = (models) => {
    alarmContact.belongsTo(models.alarmPanel, { as: 'panel', foreignKey: 'alarmPanelId' });
  };

  return alarmContact;
}
