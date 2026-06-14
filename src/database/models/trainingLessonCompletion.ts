import { DataTypes } from 'sequelize';

/**
 * A guard's completion of an individual lesson within an enrollment. One row
 * per (enrollment, lesson). Tracks first view and completion time.
 */
export default function (sequelize) {
  const trainingLessonCompletion = sequelize.define(
    'trainingLessonCompletion',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      viewedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      timeSpentSeconds: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId'] },
        { fields: ['enrollmentId'] },
        { fields: ['lessonId'] },
        {
          unique: true,
          fields: ['enrollmentId', 'lessonId'],
          where: { deletedAt: null },
        },
      ],
    },
  );

  trainingLessonCompletion.associate = (models) => {
    trainingLessonCompletion.belongsTo(models.trainingEnrollment, {
      as: 'enrollment',
      foreignKey: { name: 'enrollmentId', allowNull: false },
      constraints: false,
    });
    trainingLessonCompletion.belongsTo(models.trainingLesson, {
      as: 'lesson',
      foreignKey: { name: 'lessonId', allowNull: false },
      constraints: false,
    });
    trainingLessonCompletion.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
  };

  return trainingLessonCompletion;
}
