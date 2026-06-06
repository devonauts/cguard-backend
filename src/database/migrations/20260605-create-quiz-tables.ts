/**
 * Create the quiz tables — quizBanks (one per station), quizQuestions (the
 * question bank) and quizAttempts (graded attempts). Feeds the "quiz" factor.
 * Idempotent: skips each table that already exists.
 *
 * Run: npx ts-node src/database/migrations/20260605-create-quiz-tables.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = (await qi.showAllTables()) as string[];
  const has = (name: string) =>
    tables.some((t) => t.toLowerCase() === name.toLowerCase());

  if (!has('quizBanks')) {
    await qi.createTable('quizBanks', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      title: { type: DataTypes.STRING(255), allowNull: true },
      questionsPerAttempt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
      passPct: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 70 },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      stationId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    try {
      await qi.addIndex('quizBanks', ['tenantId', 'stationId'], {
        unique: true,
        name: 'quizBanks_tenant_station',
      });
    } catch (e) {
      console.warn('quizBanks index skipped:', (e as Error).message);
    }
    console.log('✅ quizBanks table created');
  } else {
    console.log('quizBanks already exists, skipping');
  }

  if (!has('quizQuestions')) {
    await qi.createTable('quizQuestions', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      prompt: { type: DataTypes.TEXT, allowNull: false },
      options: { type: DataTypes.TEXT, allowNull: false },
      correctIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      weight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      quizBankId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    try {
      await qi.addIndex('quizQuestions', ['tenantId', 'quizBankId'], {
        name: 'quizQuestions_tenant_bank',
      });
    } catch (e) {
      console.warn('quizQuestions index skipped:', (e as Error).message);
    }
    console.log('✅ quizQuestions table created');
  } else {
    console.log('quizQuestions already exists, skipping');
  }

  if (!has('quizAttempts')) {
    await qi.createTable('quizAttempts', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      total: { type: DataTypes.INTEGER, allowNull: false },
      correctCount: { type: DataTypes.INTEGER, allowNull: false },
      scorePct: { type: DataTypes.INTEGER, allowNull: false },
      answers: { type: DataTypes.TEXT, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: false },
      subjectType: { type: DataTypes.ENUM('guard', 'supervisor'), allowNull: false, defaultValue: 'guard' },
      quizBankId: { type: DataTypes.UUID, allowNull: false },
      subjectUserId: { type: DataTypes.UUID, allowNull: false },
      securityGuardId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    try {
      await qi.addIndex('quizAttempts', ['tenantId', 'subjectUserId', 'completedAt'], {
        name: 'quizAttempts_tenant_subject_date',
      });
      await qi.addIndex('quizAttempts', ['tenantId', 'quizBankId'], {
        name: 'quizAttempts_tenant_bank',
      });
    } catch (e) {
      console.warn('quizAttempts index skipped:', (e as Error).message);
    }
    console.log('✅ quizAttempts table created');
  } else {
    console.log('quizAttempts already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
