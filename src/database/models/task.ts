import { DataTypes } from 'sequelize';

export default function (sequelize) {
  const task = sequelize.define(
    'task',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      taskToDo: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          len: [0, 300],
          notEmpty: true,
        }
      },
      wasItDone: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      dateToDoTheTask: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      dateCompletedTask: {
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

  task.associate = (models) => {
    models.task.belongsTo(models.station, {
      as: 'taskBelongsToStation',
      constraints: false,
    });

    models.task.hasMany(models.file, {
      as: 'imageOptional',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.task.getTableName(),
        belongsToColumn: 'imageOptional',
      },
    });

    models.task.hasMany(models.file, {
      as: 'taskCompletedImage',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.task.getTableName(),
        belongsToColumn: 'taskCompletedImage',
      },
    });
    
    models.task.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: {
        allowNull: false,
      },
    });

    models.task.belongsTo(models.user, {
      as: 'createdBy',
    });

    models.task.belongsTo(models.user, {
      as: 'updatedBy',
    });
  };

  return task;
}
