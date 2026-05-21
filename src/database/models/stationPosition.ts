import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const stationPosition = sequelize.define(
    'stationPosition',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'e.g. Diurno, Nocturno, Sacafranco',
      },
      type: {
        type: DataTypes.ENUM('day', 'night', 'relief'),
        allowNull: false,
        defaultValue: 'day',
        comment: 'day=Diurno, night=Nocturno, relief=Sacafranco',
      },
      startTime: {
        type: DataTypes.STRING(5),
        allowNull: false,
        comment: 'HH:mm format e.g. 07:00',
      },
      endTime: {
        type: DataTypes.STRING(5),
        allowNull: false,
        comment: 'HH:mm format e.g. 19:00',
      },
      guardsNeeded: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  stationPosition.associate = (models) => {
    models.stationPosition.belongsTo(models.station, {
      as: 'station',
      foreignKey: 'stationId',
      constraints: false,
    });

    models.stationPosition.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });

    models.stationPosition.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.stationPosition.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return stationPosition;
}
