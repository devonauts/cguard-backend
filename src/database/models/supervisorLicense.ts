import { DataTypes } from 'sequelize';

/**
 * Supervisor licenses/credentials — the supervisor mirror of guardLicense, keyed
 * on the supervisor's USER id (supervisors have no securityGuard row). Front/back
 * images are `file` rows scoped to this table, exactly like guardLicense.
 */
export default function (sequelize) {
  const supervisorLicense = sequelize.define(
    'supervisorLicense',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      supervisorUserId: { type: DataTypes.UUID, allowNull: false },
      licenseTypeId: { type: DataTypes.UUID, allowNull: true },
      customName: { type: DataTypes.STRING(255), allowNull: true },
      number: { type: DataTypes.STRING(255), allowNull: true },
      issueDate: { type: DataTypes.DATE, allowNull: true },
      expiryDate: { type: DataTypes.DATE, allowNull: true },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
      },
      createdById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
      updatedById: { type: DataTypes.UUID, references: { model: 'users', key: 'id' } },
      importHash: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    },
    {
      indexes: [{ fields: ['tenantId'] }, { fields: ['supervisorUserId'] }],
      timestamps: true,
      paranoid: true,
    },
  );

  supervisorLicense.associate = (models) => {
    models.supervisorLicense.belongsTo(models.user, {
      as: 'supervisor',
      foreignKey: { name: 'supervisorUserId' },
    });
    models.supervisorLicense.belongsTo(models.licenseType, {
      as: 'licenseType',
      foreignKey: { name: 'licenseTypeId' },
    });
    models.supervisorLicense.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false, name: 'tenantId' },
    });
    models.supervisorLicense.belongsTo(models.user, { as: 'createdBy' });
    models.supervisorLicense.belongsTo(models.user, { as: 'updatedBy' });

    models.supervisorLicense.hasMany(models.file, {
      as: 'frontImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.supervisorLicense.getTableName(),
        belongsToColumn: 'frontImage',
      },
    });
    models.supervisorLicense.hasMany(models.file, {
      as: 'backImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.supervisorLicense.getTableName(),
        belongsToColumn: 'backImage',
      },
    });
  };

  return supervisorLicense;
}
