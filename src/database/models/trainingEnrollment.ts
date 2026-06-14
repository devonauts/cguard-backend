import { DataTypes } from 'sequelize';

/**
 * Enrollment of a guard into a course. Created by tenant admins (individual
 * guard or all_guards). Tracks progress, completion and quiz result.
 *
 * For `all_guards` assignments the original "template" row has
 * securityGuardId = null; per-guard progress rows are materialized lazily when
 * a guard opens/starts the course (an individual row per guard).
 */
export default function (sequelize) {
  const trainingEnrollment = sequelize.define(
    'trainingEnrollment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      assignmentType: {
        type: DataTypes.ENUM('individual', 'all_guards'),
        allowNull: false,
        defaultValue: 'individual',
      },
      assignedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      dueDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      startedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('assigned', 'in_progress', 'completed', 'expired'),
        allowNull: false,
        defaultValue: 'assigned',
      },
      progressPercentage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      quizPassed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      quizScore: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId'] },
        { fields: ['courseId'] },
        { fields: ['securityGuardId'] },
        { fields: ['tenantId', 'courseId', 'securityGuardId'] },
      ],
    },
  );

  trainingEnrollment.associate = (models) => {
    trainingEnrollment.belongsTo(models.trainingCourse, {
      as: 'course',
      foreignKey: { name: 'courseId', allowNull: false },
      constraints: false,
    });
    trainingEnrollment.belongsTo(models.securityGuard, {
      as: 'guard',
      foreignKey: { name: 'securityGuardId', allowNull: true },
      constraints: false,
    });
    trainingEnrollment.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    trainingEnrollment.belongsTo(models.user, { as: 'createdBy' });
    trainingEnrollment.hasMany(models.trainingLessonCompletion, {
      as: 'lessonCompletions',
      foreignKey: 'enrollmentId',
      constraints: false,
    });
  };

  return trainingEnrollment;
}
