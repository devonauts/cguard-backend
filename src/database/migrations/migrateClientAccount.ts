/**
 * Migration script to update clientAccount table
 * This script will alter the database schema to match the new model
 * 
 * IMPORTANT: Make a backup of your database before running this!
 */

https://github.com/devonauts/cguard-backend.git

require('dotenv').config();

import models from '../models';
import { QueryInterface } from 'sequelize';

async function migrate() {
    const { sequelize } = models();
    const queryInterface: QueryInterface = sequelize.getQueryInterface();

    try {
        console.log('Starting clientAccount table migration...');

        // Step 1: Add new columns
        console.log('Adding new columns...');

        await queryInterface.addColumn('clientAccounts', 'name', {
            type: 'VARCHAR(200)',
            allowNull: true, // Temporarily allow null
        });

        await queryInterface.addColumn('clientAccounts', 'website', {
            type: 'VARCHAR(255)',
            allowNull: true,
        });

        await queryInterface.addColumn('clientAccounts', 'categoryId', {
            type: 'CHAR(36)',
            allowNull: true,
        });

        // Step 2: Migrate data from commercialName to name
        console.log('Migrating data from commercialName to name...');
        await sequelize.query(`
      UPDATE clientAccounts 
      SET name = COALESCE(commercialName, 'Sin nombre')
      WHERE name IS NULL
    `);

        // Step 3: Make name column NOT NULL
        console.log('Making name column NOT NULL...');
        await queryInterface.changeColumn('clientAccounts', 'name', {
            type: 'VARCHAR(200)',
            allowNull: false,
        });

        // Step 4: Update phone and fax field lengths
        console.log('Updating phone and fax field lengths...');
        await queryInterface.changeColumn('clientAccounts', 'phoneNumber', {
            type: 'VARCHAR(20)',
            allowNull: false,
        });

        await queryInterface.changeColumn('clientAccounts', 'faxNumber', {
            type: 'VARCHAR(20)',
            allowNull: true,
        });

        console.log('✅ Migration completed successfully!');
        console.log('⚠️  Old columns (contractDate, rucNumber, commercialName, representanteId) were NOT dropped.');
        console.log('⚠️  Junction tables were NOT dropped.');
        console.log('   You can drop them manually after verifying the migration worked correctly.');

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

migrate();
