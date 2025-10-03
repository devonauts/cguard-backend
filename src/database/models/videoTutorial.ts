import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const videoTutorial = sequelize.define(
    'videoTutorial',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      videoTutorialName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          len: [0, 200],
          notEmpty: true,
        }
      },
      videoTutorialLink: {
        type: DataTypes.TEXT,
        validate: {
          len: [0, 800],
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

  videoTutorial.associate = (models) => {
    models.videoTutorial.belongsTo(models.videoTutorialCategory, {
      as: 'videoTutorialCategory',
      constraints: false,
    });


    
    models.videoTutorial.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.videoTutorial.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.videoTutorial.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return videoTutorial;
}
