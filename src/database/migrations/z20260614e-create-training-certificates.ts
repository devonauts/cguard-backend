require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create trainingCertificates table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'trainingCertificates' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (tableExists) {
      console.log('Table trainingCertificates already exists. Abort.');
      process.exit(0);
    }

    await queryInterface.createTable('trainingCertificates', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      serialNumber: { type: DataTypes.STRING(50), allowNull: false },
      guardName: { type: DataTypes.STRING(255), allowNull: false },
      courseTitle: { type: DataTypes.STRING(255), allowNull: false },
      score: { type: DataTypes.INTEGER, allowNull: true },
      issuedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      expiresAt: { type: DataTypes.DATE, allowNull: true },
      htmlContent: { type: DataTypes.TEXT('long'), allowNull: true },
      publicUrl: { type: DataTypes.TEXT, allowNull: true },
      downloadToken: { type: DataTypes.STRING(100), allowNull: true },
      courseId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'trainingCourses', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      securityGuardId: {
        type: DataTypes.UUID,
        allowNull: false,
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
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    await queryInterface.addIndex('trainingCertificates', ['serialNumber'], {
      unique: true,
      where: { deletedAt: null },
    });
    await queryInterface.addIndex('trainingCertificates', ['tenantId']);
    await queryInterface.addIndex('trainingCertificates', ['courseId']);
    await queryInterface.addIndex('trainingCertificates', ['securityGuardId']);
    await queryInterface.addIndex('trainingCertificates', ['downloadToken']);

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
