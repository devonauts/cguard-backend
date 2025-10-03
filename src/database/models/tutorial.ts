import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const tutorial = sequelize.define(
    'tutorial',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tutorialName: {
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

  tutorial.associate = (models) => {
    models.tutorial.belongsTo(models.videoTutorialCategory, {
      as: 'tutorialCategory',
      constraints: false,
    });

    models.tutorial.belongsToMany(models.videoTutorialCategory, {
      as: 'tutorialVideos',
      constraints: false,
      through: 'tutorialTutorialVideosVideoTutorialCategory',
    });


    
    models.tutorial.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.tutorial.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.tutorial.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return tutorial;
}
