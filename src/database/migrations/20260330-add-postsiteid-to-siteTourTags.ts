require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add postSiteId to siteTourTags...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'siteTourTags' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table siteTourTags does not exist — please run earlier migrations first.');
      process.exit(1);
    }

    const [col] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTourTags' AND COLUMN_NAME = 'postSiteId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((col as any[]).length === 0) {
      console.log('Adding column postSiteId to siteTourTags');
      await queryInterface.addColumn('siteTourTags', 'postSiteId', { type: DataTypes.UUID, allowNull: true });
      try {
        await queryInterface.addIndex('siteTourTags', ['postSiteId'], { name: 'idx_siteTourTags_postSiteId' });
      } catch (e) {
        // ignore index creation errors
      }
      console.log('Added postSiteId and index.');
    } else {
      console.log('Column postSiteId already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
