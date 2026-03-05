import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const siteTourTag = sequelize.define(
    'siteTourTag',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      tagType: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      tagIdentifier: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      location: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      instructions: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true,
      },
      showGeoFence: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
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

  siteTourTag.associate = (models) => {
    siteTourTag.belongsTo(models.siteTour, { as: 'siteTour', foreignKey: 'siteTourId' });
    siteTourTag.hasMany(models.tagScan, { as: 'scans', foreignKey: 'siteTourTagId' });
  };

  return siteTourTag;
}
