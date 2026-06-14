import { DataTypes } from 'sequelize';

/**
 * An ordered lesson within a training course: a video URL, rich text content,
 * and/or downloadable resources (PDF, docs).
 */
export default function (sequelize) {
  const trainingLesson = sequelize.define(
    'trainingLesson',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: { len: [0, 255], notEmpty: true },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      videoUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      richContent: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
      },
      // [{ name, url, type }]
      resources: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      durationMinutes: {
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
      ],
    },
  );

  trainingLesson.associate = (models) => {
    trainingLesson.belongsTo(models.trainingCourse, {
      as: 'course',
      foreignKey: { name: 'courseId', allowNull: false },
      constraints: false,
    });
    trainingLesson.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
    });
    trainingLesson.belongsTo(models.user, { as: 'createdBy' });
    trainingLesson.belongsTo(models.user, { as: 'updatedBy' });
    trainingLesson.hasMany(models.trainingLessonCompletion, {
      as: 'completions',
      foreignKey: 'lessonId',
      constraints: false,
    });
  };

  return trainingLesson;
}
