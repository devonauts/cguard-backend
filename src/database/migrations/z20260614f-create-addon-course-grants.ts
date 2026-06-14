require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create addonCourseGrants table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'addonCourseGrants' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (tableExists) {
      console.log('Table addonCourseGrants already exists. Abort.');
      process.exit(0);
    }

    await queryInterface.createTable('addonCourseGrants', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      grantedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      expiresAt: { type: DataTypes.DATE, allowNull: true },
      seatCount: { type: DataTypes.INTEGER, allowNull: true },
      currentEnrollments: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      pricePaid: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      status: { type: DataTypes.ENUM('active', 'expired', 'revoked'), allowNull: false, defaultValue: 'active' },
      addonCourseId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'trainingCourses', key: 'id' },
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
      grantedById: {
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

    await queryInterface.addIndex('addonCourseGrants', ['tenantId']);
    await queryInterface.addIndex('addonCourseGrants', ['addonCourseId']);
    await queryInterface.addIndex('addonCourseGrants', ['status']);
    await queryInterface.addIndex('addonCourseGrants', ['tenantId', 'addonCourseId'], {
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
