export default function (sequelize, DataTypes) {
  const Vehicle = sequelize.define(
    'vehicle',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      year: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      make: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      model: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      color: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      vin: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      initialMileage: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
      },
      ownership: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      licensePlate: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      tableName: 'vehicles',
      timestamps: true,
      paranoid: true,
    },
  );

  Vehicle.associate = (models) => {
    models.vehicle.hasMany(models.file, {
      as: 'imageUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.vehicle.getTableName(),
        belongsToColumn: 'imageUrl',
      },
    });
  };

  return Vehicle;
}
