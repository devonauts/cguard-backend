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

    // Normalize existing indexes and detect indexes by their columns (more robust
    // than relying on auto-generated index names which vary across dialects)
    const existingIndexesByColumns = (existingIndexes || []).map((idx: any) => {
      const cols = (idx.fields || idx.columnNames || idx.columns || [])
        .map((f: any) => (f && (f.attribute || f.columnName || f.name || f))?.toString().toLowerCase())
        .filter(Boolean);
      return { name: idx.name || idx.constraintName, cols };
    });

    const hasIndexWithColumns = (cols: string[]) => {
      const needle = cols.map(c => c.toString().toLowerCase());
      return existingIndexesByColumns.some((idx: any) => {
        const set = new Set(idx.cols.map((c: string) => c.replace(/_/g, '')));
        return needle.every(n => set.has(n.replace(/_/g, '')));
      });
    };

    if (!hasIndexWithColumns(['tenantUserId', 'businessInfoId'])) {
      await queryInterface.addIndex('tenant_user_post_sites', ['tenantUserId', 'businessInfoId'], {
        unique: true,
        name: 'tenant_user_post_sites_unique',
      });
    } else {
      console.log('Index tenant_user_post_sites_unique already exists, skipping');
    }

    if (!hasIndexWithColumns(['tenantUserId'])) {
      await queryInterface.addIndex('tenant_user_post_sites', ['tenantUserId']);
    } else {
      console.log('Index on tenantUserId already exists, skipping');
    }

    if (!hasIndexWithColumns(['businessInfoId'])) {
      await queryInterface.addIndex('tenant_user_post_sites', ['businessInfoId']);
    } else {
      console.log('Index on businessInfoId already exists, skipping');
    }

    console.log('✅ tenant_user_post_sites created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
