import { DataTypes } from 'sequelize';

/**
 * A supervisor's inspection of how correctly a guard (or supervisor) is
 * uniformed — feeds the "correctly uniformed" factor of the performance score.
 *
 * `rating` is stored 0..100; `stars` (1..5) is an optional convenience capture.
 * The scored person is `subject` (a user) so this works for both guards and
 * supervisors; `securityGuard` is set when the subject has a guard record.
 */
export default function (sequelize) {
  const uniformInspection = sequelize.define(
    'uniformInspection',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      inspectionDate: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      rating: {
        type: DataTypes.INTEGER, // 0..100
        allowNull: false,
        validate: { min: 0, max: 100 },
      },
      stars: {
        type: DataTypes.INTEGER, // optional 1..5 convenience
        allowNull: true,
        validate: { min: 0, max: 5 },
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // JSON array of photo descriptors (privateUrl/fileToken …)
      photos: {
        type: DataTypes.TEXT,
        allowNull: true,
        get(this: any) {
          const raw = this.getDataValue('photos');
          if (!raw) return [];
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        },
        set(this: any, val: any) {
          this.setDataValue('photos', val == null ? null : JSON.stringify(val));
        },
      },
      subjectType: {
        type: DataTypes.ENUM('guard', 'supervisor'),
        allowNull: false,
        defaultValue: 'guard',
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId', 'subjectUserId', 'inspectionDate'] },
        { fields: ['tenantId', 'securityGuardId'] },
      ],
    },
  );

  uniformInspection.associate = (models) => {
    uniformInspection.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    // The scored person (works for guards and supervisors).
    uniformInspection.belongsTo(models.user, {
      as: 'subject',
      foreignKey: { name: 'subjectUserId', allowNull: false },
      constraints: false,
    });
    // The guard record, when the subject has one.
    uniformInspection.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: true },
      constraints: false,
    });
    uniformInspection.belongsTo(models.user, {
      as: 'inspector',
      foreignKey: { name: 'inspectorId', allowNull: true },
      constraints: false,
    });
    uniformInspection.belongsTo(models.station, {
      as: 'station',
      foreignKey: { name: 'stationId', allowNull: true },
      constraints: false,
    });
    uniformInspection.belongsTo(models.user, { as: 'createdBy' });
    uniformInspection.belongsTo(models.user, { as: 'updatedBy' });
  };

  return uniformInspection;
}
