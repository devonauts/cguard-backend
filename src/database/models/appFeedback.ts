import { DataTypes } from 'sequelize';

/**
 * App feedback / rating — a CRM user's 1–5 star rating of their C-Guard Pro
 * experience + optional comment (from the header feedback modal). Surfaced to
 * superadmin across all tenants.
 */
export default function (sequelize) {
  const appFeedback = sequelize.define(
    'appFeedback',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      rating: { type: DataTypes.INTEGER, allowNull: false }, // 1..5
      comment: { type: DataTypes.TEXT, allowNull: true },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'crm' }, // crm | worker | supervisor | client
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
      },
      userId: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    },
    {
      indexes: [{ fields: ['tenantId'] }, { fields: ['rating'] }],
      timestamps: true,
    },
  );

  appFeedback.associate = (models) => {
    appFeedback.belongsTo(models.tenant, { as: 'tenant', foreignKey: { allowNull: false, name: 'tenantId' } });
    appFeedback.belongsTo(models.user, { as: 'user', foreignKey: { name: 'userId' } });
  };

  return appFeedback;
}
