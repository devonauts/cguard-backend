import { DataTypes } from 'sequelize';

/**
 * Departamentos — the tenant's INTERNAL org structure (Operaciones, Talento
 * Humano, Nómina, Supervisión, Comercial…). Orthogonal to the client→site→post
 * hierarchy: departments group PEOPLE (staff and guards via
 * tenantUsers.departmentId), not service locations. Each department has an
 * optional manager (responsable) used for escalation/routing.
 */
export default function (sequelize) {
  const department = sequelize.define(
    'department',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
        validate: { notEmpty: true },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
      },
      managerId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
      },
      createdById: {
        type: DataTypes.UUID,
        references: { model: 'users', key: 'id' },
      },
      updatedById: {
        type: DataTypes.UUID,
        references: { model: 'users', key: 'id' },
      },
    },
    {
      indexes: [
        { fields: ['tenantId', 'name'] },
        { fields: ['tenantId', 'active'] },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  department.associate = (models) => {
    models.department.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    models.department.belongsTo(models.user, {
      as: 'manager',
      foreignKey: { name: 'managerId' },
    });
    models.department.hasMany(models.tenantUser, {
      as: 'members',
      foreignKey: { name: 'departmentId' },
    });
    models.department.belongsTo(models.user, {
      as: 'createdBy',
      foreignKey: { name: 'createdById' },
    });
    models.department.belongsTo(models.user, {
      as: 'updatedBy',
      foreignKey: { name: 'updatedById' },
    });
  };

  return department;
}
