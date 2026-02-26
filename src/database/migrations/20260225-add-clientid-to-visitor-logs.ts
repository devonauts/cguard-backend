require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    // Ensure visitorLogs table exists
    try {
      await queryInterface.describeTable('visitorLogs');
    } catch (err) {
      console.log('Table visitorLogs does not exist; skipping clientId migration');
      process.exit(0);
    }

    // Check existing columns
    const tableDesc = await queryInterface.describeTable('visitorLogs');

    const hasClientId = Boolean(tableDesc && tableDesc.clientId);
    if (!hasClientId) {
      console.log('Adding clientId column to visitorLogs...');

      await queryInterface.addColumn('visitorLogs', 'clientId', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'clientAccounts',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      }).catch(() => {});
      console.log('✅ Added clientId to visitorLogs');
    } else {
      console.log('Column clientId already exists on visitorLogs, skipping column creation');
    }

    // Add postSiteId column if missing
    const visitorDescAfter = await queryInterface.describeTable('visitorLogs');
    const hasPostSiteId = Boolean(visitorDescAfter && visitorDescAfter.postSiteId);
    if (!hasPostSiteId) {
      console.log('Adding postSiteId column to visitorLogs...');
      await queryInterface.addColumn('visitorLogs', 'postSiteId', {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'businessInfos',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }).catch(() => {});
      console.log('✅ Added postSiteId to visitorLogs');
    } else {
      console.log('postSiteId already exists on visitorLogs, skipping column creation');
    }

    console.log('Creating index for visitorLogs.clientId...');
    // Add tenant-scoped composite index for faster tenant queries
    const existingIndexesRaw = await queryInterface.showIndex('visitorLogs').catch(() => []);
    const existingIndexes = Array.isArray(existingIndexesRaw) ? existingIndexesRaw as any[] : [];
    const indexNames = existingIndexes.map((i: any) => i.name || i.constraintName).filter(Boolean);

    // Add tenant-scoped composite indexes where applicable
    if (hasClientId && !indexNames.includes('visitorLogs_clientId_tenantId')) {
      await queryInterface.addIndex('visitorLogs', ['clientId', 'tenantId'], {
        name: 'visitorLogs_clientId_tenantId',
      }).catch(() => {});
      console.log('✅ Added composite index visitorLogs_clientId_tenantId');
    } else if (hasClientId) {
      console.log('Index visitorLogs_clientId_tenantId already exists or clientId missing, skipping');
    }

    if (hasPostSiteId && !indexNames.includes('visitorLogs_postSiteId_tenantId')) {
      await queryInterface.addIndex('visitorLogs', ['postSiteId', 'tenantId'], {
        name: 'visitorLogs_postSiteId_tenantId',
      }).catch(() => {});
      console.log('✅ Added composite index visitorLogs_postSiteId_tenantId');
    } else if (hasPostSiteId) {
      console.log('Index visitorLogs_postSiteId_tenantId already exists or postSiteId missing, skipping');
    }

    // Ensure single-column index exists as fallback (optional)
    if (hasClientId && !indexNames.includes('visitorLogs_clientId')) {
      await queryInterface.addIndex('visitorLogs', ['clientId'], { name: 'visitorLogs_clientId' }).catch(() => {});
    }

    console.log('✅ Added clientId to visitorLogs');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
