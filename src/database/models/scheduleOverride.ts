import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const scheduleOverride = sequelize.define(
    'scheduleOverride',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      assignmentId: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'Optional link to the guard assignment being overridden',
      },
      date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: 'V=vacation, PM=permission, F=absence, 24=24h shift, D=force day, N=force night, L=force rest',
      },
      note: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['guardId', 'date'] },
        { fields: ['assignmentId'] },
        { fields: ['tenantId', 'date'] },
      ],
    },
  );

  scheduleOverride.associate = (models) => {
    models.scheduleOverride.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });

    models.scheduleOverride.belongsTo(models.guardAssignment, {
      as: 'assignment',
      foreignKey: 'assignmentId',
      constraints: false,
    });

    models.scheduleOverride.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.scheduleOverride.belongsTo(models.user, {
      as: 'createdBy',
    });
  };

  return scheduleOverride;
}
