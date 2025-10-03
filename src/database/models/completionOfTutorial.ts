import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const completionOfTutorial = sequelize.define(
    'completionOfTutorial',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      dateTutorialStarted: {
        type: DataTypes.DATE,
      },
      tutorialStarted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      wasCompleted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      dateEndedTutorial: {
        type: DataTypes.DATE,
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

  completionOfTutorial.associate = (models) => {
    models.completionOfTutorial.belongsTo(models.securityGuard, {
      as: 'guardName',
      constraints: false,
      foreignKey: {
        allowNull: false,
      },
    });

    models.completionOfTutorial.belongsTo(models.tutorial, {
      as: 'checkedTutorial',
      constraints: false,
    });


    
    models.completionOfTutorial.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.completionOfTutorial.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.completionOfTutorial.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return completionOfTutorial;
}
