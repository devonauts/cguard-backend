import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const tagScan = sequelize.define(
    'tagScan',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      scannedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      scannedData: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      // Server-side location verification result (computed in recordTagScan from
      // the guard's GPS vs the checkpoint's coordinates). Null = could not
      // verify (checkpoint or scan lacked coordinates).
      validLocation: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: null,
      },
      // Distance in meters from the checkpoint at scan time (for audit/reporting).
      distanceMeters: {
        type: DataTypes.FLOAT,
        allowNull: true,
        defaultValue: null,
      },
        stationId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        tenantId: {
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

  tagScan.associate = (models) => {
    tagScan.belongsTo(models.siteTourTag, { as: 'tag', foreignKey: 'siteTourTagId' });
    tagScan.belongsTo(models.tourAssignment, { as: 'assignment', foreignKey: 'tourAssignmentId' });
    tagScan.belongsTo(models.securityGuard, { as: 'guard', foreignKey: 'securityGuardId' });
    // optional relation to station for better context of where the scan happened
    if (models.station) {
      tagScan.belongsTo(models.station, { as: 'station', foreignKey: 'stationId' });
    }
  };

  return tagScan;
}
