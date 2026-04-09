import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const siteTour = sequelize.define(
    'siteTour',
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
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      scheduledDays: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true,
      },
      postSiteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      stationId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      securityGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      continuous: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      timeMode: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      selectTime: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      maxDuration: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      updatedById: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
    },
  );

  siteTour.associate = (models) => {
    siteTour.hasMany(models.siteTourTag, { as: 'tags', foreignKey: 'siteTourId' });
    siteTour.hasMany(models.tourAssignment, { as: 'assignments', foreignKey: 'siteTourId' });
  };

  return siteTour;
}
