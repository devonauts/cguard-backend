import { getConfig } from '../../config';
import models from '../models';

async function migrate() {
  try {
    const config = getConfig();
    const sequelize = models().sequelize;

    console.log('Adding publishedOnMobile column to services table...');

    // Check if column already exists
    const [results]: any = await sequelize.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'services' AND COLUMN_NAME = 'publishedOnMobile'"
    );

    if (results.length === 0) {
      // Column doesn't exist, add it
      await sequelize.query(`
        ALTER TABLE services 
        ADD COLUMN publishedOnMobile BOOLEAN NOT NULL DEFAULT FALSE
      `);
      console.log('✅ publishedOnMobile column added successfully');
    } else {
      console.log('ℹ️  publishedOnMobile column already exists');
    }

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
