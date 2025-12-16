/**
 * Migration script to add categoryIds JSON field to clientAccounts
 * This replaces the single categoryId with an array of category IDs
 * 
 * IMPORTANT: Make a backup of your database before running this!
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add categoryIds JSON field to clientAccounts...');

    // Check if column already exists
    const [results] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_NAME = 'clientAccounts' AND COLUMN_NAME = 'categoryIds'`
    );

    if ((results as any[]).length > 0) {
      console.log('Column categoryIds already exists, skipping creation.');
    } else {
      // Add categoryIds as JSON column
      console.log('Adding categoryIds column...');
      await queryInterface.addColumn('clientAccounts', 'categoryIds', {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      });
      console.log('✅ Column added');
    }

    // Migrate existing categoryId data to categoryIds array
    console.log('Migrating existing categoryId data...');
    await sequelize.query(`
      UPDATE clientAccounts 
      SET categoryIds = JSON_ARRAY(categoryId)
      WHERE categoryId IS NOT NULL 
      AND deletedAt IS NULL
      AND (categoryIds IS NULL OR JSON_LENGTH(categoryIds) = 0)
    `);
    console.log('✅ Data migrated');

    console.log('\n✅ Migration completed successfully!');
    console.log('   The categoryIds field has been added and populated.');
    console.log('\n⚠️  NOTE: The old categoryId column has NOT been removed.');
    console.log('   After verifying everything works, you can drop it manually:');
    console.log('   ALTER TABLE clientAccounts DROP COLUMN categoryId;');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
