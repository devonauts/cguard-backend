/**
 * Cleanup script to remove obsolete columns from clientAccount table
 * This script will drop old columns that are no longer used
 * 
 * IMPORTANT: Make sure you have a backup before running this!
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface } from 'sequelize';

async function cleanup() {
    const { sequelize } = models();
    const queryInterface: QueryInterface = sequelize.getQueryInterface();

    try {
        console.log('Starting clientAccount table cleanup...');
        console.log('⚠️  This will permanently delete old columns!');

        // Step 1: Drop obsolete columns
        console.log('Dropping obsolete columns...');

        await queryInterface.removeColumn('clientAccounts', 'contractDate');
        console.log('✅ Dropped contractDate');

        await queryInterface.removeColumn('clientAccounts', 'rucNumber');
        console.log('✅ Dropped rucNumber');

        await queryInterface.removeColumn('clientAccounts', 'commercialName');
        console.log('✅ Dropped commercialName');

        await queryInterface.removeColumn('clientAccounts', 'representanteId');
        console.log('✅ Dropped representanteId');

        console.log('✅ Cleanup completed successfully!');
        console.log('The clientAccount table now only has the new simplified structure.');

        process.exit(0);
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        process.exit(1);
    }
}

cleanup();
