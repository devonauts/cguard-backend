require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating tenant_user_post_sites table...');

    // Ensure parent table `tenantUsers` exists before creating FKs
    try {
      await queryInterface.describeTable('tenantUsers');
    } catch (err) {
      console.error('Required parent table `tenantUsers` does not exist. Run the migration that creates tenant users first.');
      process.exit(1);
    }

    // Ensure parent table `businessInfos` exists before creating FKs
    try {
      await queryInterface.describeTable('businessInfos');
    } catch (err) {
      console.error('Required parent table `businessInfos` does not exist. Create the `businessInfos` table first (run `npm run db:create` or add a migration that creates it).');
      process.exit(1);
    }

    // Create table only if it does not exist (idempotent)
    let tableExists = true;
    try {
      await queryInterface.describeTable('tenant_user_post_sites');
    } catch (err) {
      tableExists = false;
    }

    if (!tableExists) {
      await queryInterface.createTable('tenant_user_post_sites', {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        tenantUserId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: {
            model: 'tenantUsers',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        businessInfoId: {
          type: DataTypes.UUID,
          allowNull: false,
          references: {
            model: 'businessInfos',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
        deletedAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
      });
    } else {
      console.log('Table tenant_user_post_sites already exists, skipping creation');
    }

    console.log('Creating indexes for tenant_user_post_sites...');
    // Add indexes only if they do not already exist
    // showIndex may return an object in some dialects; normalize to an array
    const existingIndexesRaw = await queryInterface.showIndex('tenant_user_post_sites').catch(() => []);
    const existingIndexes = Array.isArray(existingIndexesRaw) ? existingIndexesRaw as any[] : [];

    const indexNames = existingIndexes.map((i: any) => i.name || i.constraintName).filter(Boolean);

    if (!indexNames.includes('tenant_user_post_sites_unique')) {
      await queryInterface.addIndex('tenant_user_post_sites', ['tenantUserId', 'businessInfoId'], {
        unique: true,
        name: 'tenant_user_post_sites_unique',
      });
    } else {
      console.log('Index tenant_user_post_sites_unique already exists, skipping');
    }

    if (!indexNames.includes('tenant_user_post_sites_tenantUserId')) {
      await queryInterface.addIndex('tenant_user_post_sites', ['tenantUserId']);
    } else {
      console.log('Index tenant_user_post_sites_tenantUserId already exists, skipping');
    }

    if (!indexNames.includes('tenant_user_post_sites_businessInfoId')) {
      await queryInterface.addIndex('tenant_user_post_sites', ['businessInfoId']);
    } else {
      console.log('Index tenant_user_post_sites_businessInfoId already exists, skipping');
    }

    console.log('✅ tenant_user_post_sites created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
