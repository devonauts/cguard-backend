require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Adds an optional `courseId` to quizBanks so a bank can belong to a training
 * course (course quiz) instead of a station. Also relaxes `stationId` to be
 * nullable, since course quizzes have no station.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add courseId to quizBanks...');

    const table: any = await queryInterface.describeTable('quizBanks');

    if (!table.courseId) {
      await queryInterface.addColumn('quizBanks', 'courseId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'trainingCourses', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
      await queryInterface.addIndex('quizBanks', ['courseId']);
      console.log('Added quizBanks.courseId');
    } else {
      console.log('quizBanks.courseId already exists. Skip.');
    }

    // Relax stationId to nullable (course quizzes have no station).
    if (table.stationId && table.stationId.allowNull === false) {
      try {
        await queryInterface.changeColumn('quizBanks', 'stationId', {
          type: DataTypes.UUID,
          allowNull: true,
        });
        console.log('Relaxed quizBanks.stationId to nullable');
      } catch (e) {
        console.warn('Could not relax quizBanks.stationId (may have FK constraint):', (e as any)?.message || e);
      }
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
