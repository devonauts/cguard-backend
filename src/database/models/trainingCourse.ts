import { DataTypes } from 'sequelize';

/**
 * A professional training course. Tenants create their own courses; platform
 * superadmins create cross-tenant "addon" courses (isAddon=true) granted/sold
 * to tenants via the addonCourseGrant model.
 *
 * A course has ordered lessons, an optional quiz bank (reuses the existing
 * quizBank model via courseId), a points value (feeds the guard performance
 * "training" factor), and an optional certificate template.
 */
export default function (sequelize) {
  const trainingCourse = sequelize.define(
    'trainingCourse',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
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
      coverUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      category: {
        type: DataTypes.ENUM('security', 'compliance', 'skills', 'safety', 'other'),
        allowNull: true,
      },
      level: {
        type: DataTypes.ENUM('beginner', 'intermediate', 'advanced'),
        allowNull: true,
      },
      pointsValue: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      passingScore: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 70,
      },
      isAddon: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      addonPrice: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      certificateTemplate: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      published: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { fields: ['tenantId'] },
        { fields: ['isAddon'] },
        { fields: ['category'] },
      ],
    },
  );

  trainingCourse.associate = (models) => {
    // Platform addon courses are NOT tenant-scoped (tenantId nullable). Tenant
    // courses always carry a tenantId. Allow null here so addon catalog courses
    // can be created by superadmin without a tenant.
    trainingCourse.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: true },
    });
    trainingCourse.belongsTo(models.user, { as: 'createdBy' });
    trainingCourse.belongsTo(models.user, { as: 'updatedBy' });

    trainingCourse.hasMany(models.trainingLesson, {
      as: 'lessons',
      foreignKey: 'courseId',
      constraints: false,
    });
    trainingCourse.hasOne(models.quizBank, {
      as: 'quiz',
      foreignKey: 'courseId',
      constraints: false,
    });
    trainingCourse.hasMany(models.trainingEnrollment, {
      as: 'enrollments',
      foreignKey: 'courseId',
      constraints: false,
    });
    trainingCourse.hasMany(models.trainingCertificate, {
      as: 'certificates',
      foreignKey: 'courseId',
      constraints: false,
    });
  };

  return trainingCourse;
}
