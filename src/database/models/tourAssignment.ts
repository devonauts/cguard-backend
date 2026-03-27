import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const tourAssignment = sequelize.define(
    'tourAssignment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      startAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      endAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'assigned',
      },
      siteTourId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      securityGuardId: {
        type: DataTypes.UUID,
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
      tenantId: {
        type: DataTypes.UUID,
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

  tourAssignment.associate = (models) => {
    tourAssignment.belongsTo(models.siteTour, { as: 'siteTour', foreignKey: 'siteTourId' });
    tourAssignment.belongsTo(models.securityGuard, { as: 'guard', foreignKey: 'securityGuardId' });
    tourAssignment.hasMany(models.tagScan, { as: 'scans', foreignKey: 'tourAssignmentId' });
  };

  return tourAssignment;
}
