require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create trainingCourses table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'trainingCourses' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (tableExists) {
      console.log('Table trainingCourses already exists. Abort.');
      process.exit(0);
    }

    await queryInterface.createTable('trainingCourses', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      title: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      coverUrl: { type: DataTypes.TEXT, allowNull: true },
      category: { type: DataTypes.ENUM('security', 'compliance', 'skills', 'safety', 'other'), allowNull: true },
      level: { type: DataTypes.ENUM('beginner', 'intermediate', 'advanced'), allowNull: true },
      pointsValue: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      passingScore: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 70 },
      isAddon: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      addonPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      certificateTemplate: { type: DataTypes.TEXT, allowNull: true },
      published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: true,
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
      updatedById: {
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

    await queryInterface.addIndex('trainingCourses', ['tenantId']);
    await queryInterface.addIndex('trainingCourses', ['isAddon']);
    await queryInterface.addIndex('trainingCourses', ['category']);

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
