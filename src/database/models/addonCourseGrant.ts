import { DataTypes } from 'sequelize';

/**
 * A platform addon course granted (and optionally sold) to a tenant by a
 * superadmin. The presence of an active grant = the tenant has access to the
 * addon course (which lives as a trainingCourse with isAddon=true).
 */
export default function (sequelize) {
  const addonCourseGrant = sequelize.define(
    'addonCourseGrant',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      grantedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      seatCount: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      currentEnrollments: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      pricePaid: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('active', 'expired', 'revoked'),
        allowNull: false,
        defaultValue: 'active',
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId'] },
        { fields: ['addonCourseId'] },
        { fields: ['status'] },
        {
          unique: true,
          fields: ['tenantId', 'addonCourseId'],
          where: { deletedAt: null },
        },
      ],
    },
  );

  addonCourseGrant.associate = (models) => {
    addonCourseGrant.belongsTo(models.trainingCourse, {
      as: 'addonCourse',
      foreignKey: { name: 'addonCourseId', allowNull: false },
      constraints: false,
    });
    addonCourseGrant.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    addonCourseGrant.belongsTo(models.user, { as: 'grantedBy', foreignKey: 'grantedById' });
  };

  return addonCourseGrant;
}
