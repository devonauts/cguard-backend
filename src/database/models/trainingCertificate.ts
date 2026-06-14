import { DataTypes } from 'sequelize';

/**
 * A "C-Guard Pro" branded achievement certificate issued to a guard on passing
 * a training course. Carries a unique serial, the guard/course/date/score
 * snapshot, rendered HTML for print/download, and a stateless downloadToken for
 * public (unauthenticated) sharing.
 */
export default function (sequelize) {
  const trainingCertificate = sequelize.define(
    'trainingCertificate',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      serialNumber: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },
      guardName: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      courseTitle: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      score: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      issuedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      htmlContent: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
      },
      publicUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      downloadToken: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId'] },
        { fields: ['courseId'] },
        { fields: ['securityGuardId'] },
        { fields: ['downloadToken'] },
      ],
    },
  );

  trainingCertificate.associate = (models) => {
    trainingCertificate.belongsTo(models.trainingCourse, {
      as: 'course',
      foreignKey: { name: 'courseId', allowNull: false },
      constraints: false,
    });
    trainingCertificate.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: false },
      constraints: false,
    });
    trainingCertificate.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
  };

  return trainingCertificate;
}
