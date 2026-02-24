require('dotenv').config();

import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const models = require('../models').default;
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating users table...');

    try {
      await queryInterface.describeTable('users');
      console.log('users already exists, skipping');
      process.exit(0);
    } catch (e) {
      // continue to create
    }

    await queryInterface.createTable('users', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      fullName: { type: DataTypes.STRING(255), allowNull: true },
      firstName: { type: DataTypes.STRING(80), allowNull: true },
      password: { type: DataTypes.STRING(255), allowNull: true },
      emailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      emailVerificationToken: { type: DataTypes.STRING(255), allowNull: true },
      emailVerificationTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
      provider: { type: DataTypes.STRING(255), allowNull: true },
      providerId: { type: DataTypes.STRING(2024), allowNull: true },
      passwordResetToken: { type: DataTypes.STRING(255), allowNull: true },
      passwordResetTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
      lastName: { type: DataTypes.STRING(175), allowNull: true },
      phoneNumber: { type: DataTypes.STRING(24), allowNull: true },
      email: { type: DataTypes.STRING(255), allowNull: false },
      jwtTokenInvalidBefore: { type: DataTypes.DATE, allowNull: true },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true },
      importHash: { type: DataTypes.STRING(255), allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });

    // Add unique indexes consistent with model
    try {
      await queryInterface.addIndex('users', ['email'], { unique: true, where: { deletedAt: null }, name: 'users_email_unique' });
    } catch (e) {}
    try {
      await queryInterface.addIndex('users', ['importHash'], { unique: true, where: { deletedAt: null }, name: 'users_importhash_unique' });
    } catch (e) {}

    console.log('✅ users created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
