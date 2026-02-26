/**
 * Migration script to create clientAccountCategories junction table
 * and migrate existing categoryId data to the new N:N relationship
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
    console.log('Starting migration: create clientAccountCategories junction table...');

    // Step 1: Create the junction table
    console.log('Creating clientAccountCategories table...');
    // Create table only if it does not exist
    let tableExists = true;
    try {
      await queryInterface.describeTable('clientAccountCategories');
    } catch (err) {
      tableExists = false;
    }

    if (!tableExists) {
      await queryInterface.createTable('clientAccountCategories', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'clientAccounts',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      categoryId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'categories',
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
    }

    console.log('✅ Table created successfully');

    // Step 2: Create indexes
    console.log('Creating indexes...');
    const existingIndexesRaw = await queryInterface.showIndex('clientAccountCategories').catch(() => []);
    const existingIndexes = Array.isArray(existingIndexesRaw) ? existingIndexesRaw as any[] : [];
    const indexNames = existingIndexes.map((i: any) => i.name || i.constraintName).filter(Boolean);

    if (!indexNames.includes('client_account_categories_unique')) {
      await queryInterface.addIndex('clientAccountCategories', ['clientAccountId', 'categoryId'], {
        unique: true,
        name: 'client_account_categories_unique',
      });
    } else {
      console.log('Index client_account_categories_unique already exists, skipping');
    }

    if (!indexNames.includes('client_account_categories_clientAccountId')) {
      await queryInterface.addIndex('clientAccountCategories', ['clientAccountId']);
    } else {
      console.log('Index client_account_categories_clientAccountId already exists, skipping');
    }

    if (!indexNames.includes('client_account_categories_categoryId')) {
      await queryInterface.addIndex('clientAccountCategories', ['categoryId']);
    } else {
      console.log('Index client_account_categories_categoryId already exists, skipping');
    }
    console.log('✅ Indexes created');

    // Step 3: Migrate existing data from categoryId to junction table
    console.log('Migrating existing categoryId data...');

    // Check if the old column `categoryId` exists before querying
    let clientAccountsDesc: any = {};
    try {
      clientAccountsDesc = await queryInterface.describeTable('clientAccounts');
    } catch (err) {
      clientAccountsDesc = {};
    }

    if (!clientAccountsDesc || !clientAccountsDesc['categoryId']) {
      console.log('No old column `categoryId` found on clientAccounts; skipping migration of categoryId data');
    } else {
      const [clientsWithCategory] = await sequelize.query(`
        SELECT id, categoryId 
        FROM clientAccounts 
        WHERE categoryId IS NOT NULL 
        AND deletedAt IS NULL
      `);

      if (clientsWithCategory && (clientsWithCategory as any[]).length > 0) {
      console.log(`Found ${(clientsWithCategory as any[]).length} clients with categories to migrate`);
      
      for (const client of clientsWithCategory as any[]) {
        await sequelize.query(`
          INSERT INTO clientAccountCategories (id, clientAccountId, categoryId, createdAt, updatedAt)
          VALUES (UUID(), :clientId, :categoryId, NOW(), NOW())
        `, {
          replacements: {
            clientId: client.id,
            categoryId: client.categoryId,
          },
        });
      }
      console.log(`✅ Migrated ${(clientsWithCategory as any[]).length} category associations`);
    }
    }

    // Step 4: Optional - Remove old categoryId column (commented out for safety)
    console.log('\n⚠️  NOTE: The old categoryId column in clientAccounts table has NOT been removed.');
    console.log('   After verifying everything works correctly, you can manually drop it:');
    console.log('   ALTER TABLE clientAccounts DROP COLUMN categoryId;');
    
    // Uncomment the following lines ONLY after verifying the migration worked correctly:
    // console.log('Removing old categoryId column...');
    // await queryInterface.removeColumn('clientAccounts', 'categoryId');
    // console.log('✅ Old categoryId column removed');

    console.log('\n✅ Migration completed successfully!');
    console.log('   The clientAccountCategories table has been created and data migrated.');
    console.log('   Test thoroughly before removing the old categoryId column.');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
