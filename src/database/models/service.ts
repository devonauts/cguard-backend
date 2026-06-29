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
        allowNull: true,
        
        validate: {
          len: [0, 800],
          notEmpty: false,
        }
      },
      price: {
        type: DataTypes.DECIMAL,
        allowNull: true,
        
        validate: {

        }
      },
      taxId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'taxes',
          key: 'id',
        },
      },
      taxName: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      taxRate: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: true,
      },
      publishedOnMobile: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Named icon for templated services (e.g. 'cctv','alarm','patrol'). The app +
      // CRM preview render it from a shared icon set, so a template can pass an icon
      // without an uploaded image. Falls back to the uploaded iconImage when absent.
      iconName: {
        type: DataTypes.STRING(40),
        allowNull: true,
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
        allowNull: true,
        
      },
      onDelete: 'CASCADE',
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
