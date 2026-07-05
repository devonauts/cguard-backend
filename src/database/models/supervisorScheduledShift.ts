import { DataTypes } from 'sequelize';

/**
 * Generated (planned) supervisor schedule — the output of the supervisor rotation
 * engine (puesto rotation + assignment offset → dated día/noche shifts). This is
 * the PLAN; `supervisorShift` remains the actual clock-in/out record. Isolated
 * from the guard `shift` table.
 */
export default function (sequelize) {
  const supervisorScheduledShift = sequelize.define(
    'supervisorScheduledShift',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      positionId: { type: DataTypes.UUID, allowNull: false },
      assignmentId: { type: DataTypes.UUID, allowNull: false },
      startTime: { type: DataTypes.DATE, allowNull: false }, // true UTC instant
      endTime: { type: DataTypes.DATE, allowNull: false },
      shiftKind: { type: DataTypes.STRING(16), allowNull: false }, // day | night
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
      },
      createdById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
      updatedById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
    },
    {
      indexes: [
        { fields: ['tenantId', 'supervisorUserId'] },
        { fields: ['positionId'] },
        { fields: ['assignmentId'] },
        { unique: true, fields: ['tenantId', 'supervisorUserId', 'startTime', 'endTime'] },
      ],
      timestamps: true,
    },
  );

  supervisorScheduledShift.associate = (models) => {
    supervisorScheduledShift.belongsTo(models.supervisorPosition, { as: 'position', foreignKey: { name: 'positionId' } });
    supervisorScheduledShift.belongsTo(models.user, { as: 'supervisor', foreignKey: { name: 'supervisorUserId' } });
    supervisorScheduledShift.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false, name: 'tenantId' } });
  };

  return supervisorScheduledShift;
}
