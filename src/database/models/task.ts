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
      // ── Approval workflow (client task → CRM approval → worker shift to-do) ──
      // pending_approval | approved | rejected | completed | cancelled
      status: { type: DataTypes.STRING(30), allowNull: true, defaultValue: 'pending_approval' },
      source: { type: DataTypes.STRING(20), allowNull: true }, // 'client' | 'staff'
      priority: { type: DataTypes.STRING(10), allowNull: true, defaultValue: 'media' }, // alta|media|baja
      // Richer create-task fields (supervisor "Create Task" screen).
      description: { type: DataTypes.TEXT, allowNull: true },
      assignedGuardId: { type: DataTypes.UUID, allowNull: true }, // assign to a specific guard (securityGuard.id)
      repeatConfig: { type: DataTypes.TEXT, allowNull: true }, // JSON repeat rule
      approvedById: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      approvalNotes: { type: DataTypes.TEXT, allowNull: true },
      clientAccountId: { type: DataTypes.UUID, allowNull: true }, // client who created it
      completedByGuardId: { type: DataTypes.UUID, allowNull: true }, // guard who completed it
      completionNotes: { type: DataTypes.TEXT, allowNull: true }, // what the guard reported doing
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

    // Voice instructions recorded when creating the task (supervisor app).
    models.task.hasMany(models.file, {
      as: 'voiceNote',
      foreignKey: 'belongsToId',
      constraints: false,
      scope: {
        belongsTo: models.task.getTableName(),
        belongsToColumn: 'voiceNote',
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

    // Passdown (pase de turno) that produced this task, when source='passdown'.
    models.task.belongsTo(models.shiftPassdown, {
      as: 'passdown',
      foreignKey: 'passdownId',
      constraints: false,
    });
  };

  return task;
}
