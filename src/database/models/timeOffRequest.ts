import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const timeOffRequest = sequelize.define(
    'timeOffRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      requestDate: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      type: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      startTime: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      endTime: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      comment: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'pending',
      },
      isPaid: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      guardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  timeOffRequest.associate = (models) => {
    models.timeOffRequest.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.timeOffRequest.belongsTo(models.user, {
      as: 'guard',
      foreignKey: 'guardId',
      constraints: false,
    });

    models.timeOffRequest.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.timeOffRequest.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return timeOffRequest;
}
