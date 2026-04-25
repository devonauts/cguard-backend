/**
 * Migration: Add isSuperadmin column to users table
 * Run with: npx ts-node src/database/migrations/20260424-add-issuperadmin-to-users.ts
 */
require('dotenv').config();
import models from '../models';

async function migrate() {
  const db = models();
  const queryInterface = db.sequelize.getQueryInterface();

  try {
    // Check if column already exists
    const tableDescription = await queryInterface.describeTable('users');
    
    if (!tableDescription.isSuperadmin) {
      console.log('Adding isSuperadmin column to users table...');
      
      await queryInterface.addColumn('users', 'isSuperadmin', {
        type: db.Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
      
      console.log('✅ isSuperadmin column added successfully');
    } else {
      console.log('⚠️ isSuperadmin column already exists, skipping');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
