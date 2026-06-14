require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create trainingEnrollments table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'trainingEnrollments' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (tableExists) {
      console.log('Table trainingEnrollments already exists. Abort.');
      process.exit(0);
    }

    await queryInterface.createTable('trainingEnrollments', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      assignmentType: { type: DataTypes.ENUM('individual', 'all_guards'), allowNull: false, defaultValue: 'individual' },
      assignedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      dueDate: { type: DataTypes.DATE, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      status: { type: DataTypes.ENUM('assigned', 'in_progress', 'completed', 'expired'), allowNull: false, defaultValue: 'assigned' },
      progressPercentage: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      quizPassed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      quizScore: { type: DataTypes.INTEGER, allowNull: true },
      courseId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'trainingCourses', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      securityGuardId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'securityGuards', key: 'id' },
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
      createdById: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    await queryInterface.addIndex('trainingEnrollments', ['tenantId']);
    await queryInterface.addIndex('trainingEnrollments', ['courseId']);
    await queryInterface.addIndex('trainingEnrollments', ['securityGuardId']);
    await queryInterface.addIndex('trainingEnrollments', ['tenantId', 'courseId', 'securityGuardId']);

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
