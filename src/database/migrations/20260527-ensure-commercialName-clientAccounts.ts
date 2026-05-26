/**
 * Migration: Ensure `commercialName` exists and is populated
 * - Adds `commercialName` column if missing
 * - Populates `commercialName` from `name` for all rows where NULL
 * - Logs counts before and after for visibility
 * Safe to run multiple times.
 */

require('dotenv').config();

import { QueryInterface } from 'sequelize';

async function migrate() {
  const models = require('../models').default;
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: ensure commercialName exists and populated');

    const tableDesc = await queryInterface.describeTable('clientAccounts').catch(() => ({}));

    // Report counts before
    try {
      const [beforeCountRows] = await sequelize.query(`SELECT COUNT(*) as total, SUM(CASE WHEN commercialName IS NULL OR commercialName = '' THEN 1 ELSE 0 END) as missing_commercial FROM clientAccounts`);
      console.log('- Before counts:', JSON.stringify((beforeCountRows as any)[0] || {}));
    } catch (e) {
      console.log('- Before counts: could not query counts (column may be missing yet).', e && e.message ? e.message : e);
    }

    if (!tableDesc || !Object.prototype.hasOwnProperty.call(tableDesc, 'commercialName')) {
      console.log('- Column commercialName missing: adding it (VARCHAR(200) NULL)');
      await queryInterface.addColumn('clientAccounts', 'commercialName', {
        type: 'VARCHAR(200)',
        allowNull: true,
      });
      console.log('- Column added');
    } else {
      console.log('- Column commercialName already exists');
    }

    // Populate missing values
    console.log('- Populating commercialName from name where NULL or empty');
    await sequelize.query(`UPDATE clientAccounts SET commercialName = name WHERE commercialName IS NULL OR commercialName = ''`);

    // Report counts after
    try {
      const [afterCountRows] = await sequelize.query(`SELECT COUNT(*) as total, SUM(CASE WHEN commercialName IS NULL OR commercialName = '' THEN 1 ELSE 0 END) as missing_commercial FROM clientAccounts`);
      console.log('- After counts:', JSON.stringify((afterCountRows as any)[0] || {}));
    } catch (e) {
      console.log('- After counts: could not query counts.', e && e.message ? e.message : e);
    }

    console.log('✅ Migration completed: commercialName ensured and populated.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

migrate();
