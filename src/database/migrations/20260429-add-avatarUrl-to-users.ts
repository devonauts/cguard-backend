/**
 * Migration script: add avatarUrl to users to store avatar download URL or path
 */
require('dotenv').config();

import { DataTypes } from 'sequelize';

async function migrate() {
  const models = require('../models').default;
  const { sequelize } = models();
  const queryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding avatarUrl column to users (if missing)...');

    let exists = true;
    try {
      const desc = await queryInterface.describeTable('users');
      if (!desc.avatarUrl) exists = false;
    } catch (e) {
      // If table doesn't exist, exit with error
      console.error('Users table not found, cannot add avatarUrl');
      process.exit(1);
    }

    if (exists) {
      console.log('avatarUrl already exists on users, skipping');
      process.exit(0);
    }

    await queryInterface.addColumn('users', 'avatarUrl', {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    });

    console.log('✅ avatarUrl column added to users');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
