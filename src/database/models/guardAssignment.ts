import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const guardAssignment = sequelize.define(
    'guardAssignment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'User ID of the security guard',
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      positionId: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'The station position this guard fills',
      },
      rotationStyleId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: 'When this rotation assignment begins',
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: 'When this assignment ends (null = indefinite)',
      },
      platoonOffset: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Offset in days from rotation start to stagger platoons',
      },
      isRelief: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'True if this is a sacafranco/floating relief guard',
      },
      status: {
        type: DataTypes.ENUM('active', 'paused', 'ended'),
        allowNull: false,
        defaultValue: 'active',
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['guardId', 'stationId'] },
        { fields: ['positionId'] },
        { fields: ['status'] },
      ],
    },
  );

  guardAssignment.associate = (models) => {
    models.guardAssignment.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.stationPosition, {
      as: 'position',
      foreignKey: 'positionId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.rotationStyle, {
      as: 'rotationStyle',
      foreignKey: 'rotationStyleId',
      constraints: false,
    });

    models.guardAssignment.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.guardAssignment.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.guardAssignment.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return guardAssignment;
}
