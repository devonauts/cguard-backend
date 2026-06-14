require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create trainingLessonCompletions table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'trainingLessonCompletions' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (tableExists) {
      console.log('Table trainingLessonCompletions already exists. Abort.');
      process.exit(0);
    }

    await queryInterface.createTable('trainingLessonCompletions', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      viewedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      timeSpentSeconds: { type: DataTypes.INTEGER, allowNull: true },
      enrollmentId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'trainingEnrollments', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      lessonId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'trainingLessons', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    await queryInterface.addIndex('trainingLessonCompletions', ['tenantId']);
    await queryInterface.addIndex('trainingLessonCompletions', ['enrollmentId']);
    await queryInterface.addIndex('trainingLessonCompletions', ['lessonId']);
    await queryInterface.addIndex('trainingLessonCompletions', ['enrollmentId', 'lessonId'], {
      unique: true,
      where: { deletedAt: null },
    });

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
