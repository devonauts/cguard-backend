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

                // Step 1: Drop obsolete columns (only if they exist)
                console.log('Dropping obsolete columns...');

                const tableDesc = await queryInterface.describeTable('clientAccounts').catch(() => ({}));

                const tryRemove = async (col: string) => {
                    if (tableDesc && Object.prototype.hasOwnProperty.call(tableDesc, col)) {
                        try {
                            await queryInterface.removeColumn('clientAccounts', col);
                            console.log(`✅ Dropped ${col}`);
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            console.warn(`⚠️ Failed to drop ${col}:`, msg);
                        }
                    } else {
                        console.log(`- Column ${col} does not exist, skipping`);
                    }
                };

                await tryRemove('contractDate');
                await tryRemove('rucNumber');
                await tryRemove('commercialName');
                await tryRemove('representanteId');

        console.log('✅ Cleanup completed successfully!');
        console.log('The clientAccount table now only has the new simplified structure.');

        process.exit(0);
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        process.exit(1);
    }
}

cleanup();
