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
        comment: 'e.g. Fijo 1, Fijo 2, Sacafranco',
      },
      type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'fijo',
        comment: 'fijo=fixed rotating position, sacafranco=relief',
      },
      startTime: {
        type: DataTypes.STRING(5),
        allowNull: false,
        comment: 'Day shift start HH:mm e.g. 07:00',
      },
      endTime: {
        type: DataTypes.STRING(5),
        allowNull: false,
        comment: 'Day shift end HH:mm e.g. 19:00',
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
