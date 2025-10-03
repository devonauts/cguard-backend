import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const service = sequelize.define(
    'service',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.TEXT,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 800],
          notEmpty: true,
        }
      },
      price: {
        type: DataTypes.DECIMAL,
        allowNull: false,
        validate: {

        }
      },
      specifications: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 800],
          notEmpty: true,
        }
      },
      subtitle: {
        type: DataTypes.STRING(150),
        validate: {
          len: [0, 150],
        }
      },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,    
        validate: {
          len: [0, 255],
        },    
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

      ],
      timestamps: true,
      paranoid: true,
    },
  );

  service.associate = (models) => {


    models.service.hasMany(models.file, {
      as: 'iconImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.service.getTableName(),
        belongsToColumn: 'iconImage',
      },
    });

    models.service.hasMany(models.file, {
      as: 'serviceImages',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.service.getTableName(),
        belongsToColumn: 'serviceImages',
      },
    });
    
    models.service.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.service.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.service.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return service;
}
