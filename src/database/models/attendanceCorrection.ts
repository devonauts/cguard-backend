import { DataTypes } from 'sequelize';

/**
 * Attendance manual correction — an auditable request to change a field on a
 * guardShift (e.g. punchInTime, punchOutTime, status). The ORIGINAL value is
 * preserved immutably; the corrected value is applied only when approved.
 * Tenant-scoped, audited, paranoid.
 */
export default function (sequelize) {
  const attendanceCorrection = sequelize.define(
    'attendanceCorrection',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // The guardShift field being corrected (e.g. 'punchInTime').
      field: { type: DataTypes.STRING(64), allowNull: false },
      originalValue: { type: DataTypes.TEXT, allowNull: true },
      correctedValue: { type: DataTypes.TEXT, allowNull: true },
      reason: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: { notEmpty: true },
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending', // pending | approved | rejected | applied
      },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      approvalNotes: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  attendanceCorrection.associate = (models) => {
    models.attendanceCorrection.belongsTo(models.guardShift, {
      as: 'guardShift',
      foreignKey: 'guardShiftId',
      constraints: false,
    });
    models.attendanceCorrection.belongsTo(models.user, {
      as: 'requestedBy',
      foreignKey: 'requestedById',
      constraints: false,
    });
    models.attendanceCorrection.belongsTo(models.user, {
      as: 'approvedBy',
      foreignKey: 'approvedById',
      constraints: false,
    });

    models.attendanceCorrection.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.attendanceCorrection.belongsTo(models.user, { as: 'createdBy' });
    models.attendanceCorrection.belongsTo(models.user, { as: 'updatedBy' });
  };

  return attendanceCorrection;
}
