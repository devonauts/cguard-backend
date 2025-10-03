import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const bannerSuperiorApp = sequelize.define(
    'bannerSuperiorApp',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          len: [0, 255],
          notEmpty: true,
        }
      },
      link: {
        type: DataTypes.TEXT,
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

  bannerSuperiorApp.associate = (models) => {


    models.bannerSuperiorApp.hasMany(models.file, {
      as: 'imageUrl',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.bannerSuperiorApp.getTableName(),
        belongsToColumn: 'imageUrl',
      },
    });
    
    models.bannerSuperiorApp.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.bannerSuperiorApp.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.bannerSuperiorApp.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return bannerSuperiorApp;
}
