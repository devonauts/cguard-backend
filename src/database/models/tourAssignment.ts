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
