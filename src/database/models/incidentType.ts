import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const incidentType = sequelize.define(
    'incidentType',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: true,
        },
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenants',
          key: 'id',
        },
      },
      createdById: {
        type: DataTypes.UUID,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      updatedById: {
        type: DataTypes.UUID,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        unique: true,
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: ['importHash', 'tenantId'],
          where: {
            deletedAt: null,
          },
        },
        {
          fields: ['name', 'tenantId'],
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  incidentType.associate = (models) => {
    models.incidentType.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.incidentType.belongsTo(models.user, {
      as: 'createdBy',
      foreignKey: {
        name: 'createdById',
      },
    });

    models.incidentType.belongsTo(models.user, {
      as: 'updatedBy',
      foreignKey: {
        name: 'updatedById',
      },
    });
  };

  return incidentType;
}
