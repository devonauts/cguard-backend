/**
 * Migration: Restore `commercialName` column on clientAccounts
 * - If the column is missing, add it (VARCHAR(200) NULL)
 * - Populate commercialName from name when commercialName is NULL
 * This migration is safe to run multiple times (it checks existence first).
 */

require('dotenv').config();

import { QueryInterface } from 'sequelize';

async function migrate() {
  // Require models after dotenv to ensure DB config is loaded
  const models = require('../models').default;
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: restore commercialName on clientAccounts');

    const tableDesc = await queryInterface.describeTable('clientAccounts').catch(() => ({}));

    if (tableDesc && Object.prototype.hasOwnProperty.call(tableDesc, 'commercialName')) {
      console.log('- Column commercialName already exists; nothing to do.');
      process.exit(0);
    }

    console.log('- Adding column commercialName (VARCHAR(200))');
    await queryInterface.addColumn('clientAccounts', 'commercialName', {
      type: 'VARCHAR(200)',
      allowNull: true,
    });

    // Populate commercialName from name when empty, to keep parity with previous behavior
    console.log('- Populating commercialName from name where NULL');
    // Use a safe UPDATE compatible with both MySQL and Postgres
    await sequelize.query(`
      UPDATE clientAccounts
      SET commercialName = name
      WHERE commercialName IS NULL
    `);

    console.log('✅ Migration completed: commercialName restored.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
