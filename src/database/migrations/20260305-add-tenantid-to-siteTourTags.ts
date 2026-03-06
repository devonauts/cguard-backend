require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: add tenantId to siteTourTags...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'siteTourTags' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table siteTourTags does not exist — creating table.');

      await queryInterface.createTable('siteTourTags', {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        name: { type: DataTypes.STRING(200), allowNull: false },
        tagType: { type: DataTypes.STRING(50), allowNull: true },
        tagIdentifier: { type: DataTypes.STRING(200), allowNull: false },
        location: { type: DataTypes.STRING(200), allowNull: true },
        instructions: { type: DataTypes.TEXT, allowNull: true },
        latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
        longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
        showGeoFence: { type: DataTypes.BOOLEAN, defaultValue: false },
        tenantId: { type: DataTypes.UUID, allowNull: false },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
        siteTourId: { type: DataTypes.UUID, allowNull: true },
      });

      await queryInterface.addIndex('siteTourTags', ['tenantId'], { name: 'idx_siteTourTags_tenantId' });

      console.log('Created siteTourTags with tenantId and index.');
      process.exit(0);
    }

    const [tenantCol] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'siteTourTags' AND COLUMN_NAME = 'tenantId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((tenantCol as any[]).length === 0) {
      console.log('Adding column tenantId to siteTourTags');
      await queryInterface.addColumn('siteTourTags', 'tenantId', { type: DataTypes.UUID, allowNull: false });
      await queryInterface.addIndex('siteTourTags', ['tenantId'], { name: 'idx_siteTourTags_tenantId' });
      console.log('Added tenantId and index.');
    } else {
      console.log('Column tenantId already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
