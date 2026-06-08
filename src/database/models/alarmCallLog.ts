import { DataTypes } from 'sequelize';

export default function (sequelize) {
  // Enhanced Call Verification (ECV) call attempts for an alarm case.
  const alarmCallLog = sequelize.define(
    'alarmCallLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      alarmCaseId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      alarmContactId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      contactName: {
        type: DataTypes.STRING(160),
        allowNull: true,
      },
      phone: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      // contacted | no_answer | verified_real | verified_false | cancel_passcode
      outcome: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      actorId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  alarmCallLog.associate = (models) => {
    alarmCallLog.belongsTo(models.alarmCase, { as: 'case', foreignKey: 'alarmCaseId' });
  };

  return alarmCallLog;
}
