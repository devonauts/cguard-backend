import { DataTypes } from 'sequelize';

/**
 * A supervisor assigned to a "puesto de supervisor" — mirror of guardAssignment
 * but isolated (user-keyed, no station/shift tables). The rotation style is
 * inherited from the position; `platoonOffset` staggers supervisors so they
 * alternate (Sup A día while Sup B noche, then rotate). Their concrete schedule
 * is generated from (position rotation + this assignment).
 */
export default function (sequelize) {
  const supervisorPositionAssignment = sequelize.define(
    'supervisorPositionAssignment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      positionId: { type: DataTypes.UUID, allowNull: false },
      startDate: { type: DataTypes.DATEONLY, allowNull: false },
      endDate: { type: DataTypes.DATEONLY, allowNull: true },
      // Days offset from rotation start — staggers this supervisor's phase.
      platoonOffset: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isRelief: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
      },
      createdById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
      updatedById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
    },
    {
      indexes: [{ fields: ['tenantId'] }, { fields: ['positionId'] }, { fields: ['supervisorUserId'] }],
      timestamps: true,
      paranoid: true,
    },
  );

  supervisorPositionAssignment.associate = (models) => {
    supervisorPositionAssignment.belongsTo(models.supervisorPosition, { as: 'position', foreignKey: { name: 'positionId' } });
    supervisorPositionAssignment.belongsTo(models.user, { as: 'supervisor', foreignKey: { name: 'supervisorUserId' } });
    supervisorPositionAssignment.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false, name: 'tenantId' } });
  };

  return supervisorPositionAssignment;
}
