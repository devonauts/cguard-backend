import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const videoTutorialCategory = sequelize.define(
    'videoTutorialCategory',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      categoryName: {
        type: DataTypes.STRING(200),
        validate: {
          len: [0, 200],
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

  videoTutorialCategory.associate = (models) => {
    models.videoTutorialCategory.hasMany(models.videoTutorial, {
      as: 'videosInCategory',
      constraints: false,
      foreignKey: 'videoTutorialCategoryId',
    });


    
    models.videoTutorialCategory.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.videoTutorialCategory.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.videoTutorialCategory.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return videoTutorialCategory;
}
