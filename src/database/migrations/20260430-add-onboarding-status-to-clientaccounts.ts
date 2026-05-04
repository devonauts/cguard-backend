require('dotenv').config();

import { QueryInterface, DataTypes } from 'sequelize';
import models from '../models';

const TABLE = 'clientAccounts';
const COLUMN = 'onboardingStatus';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    // 1. Check if column already exists
    const result: any = await queryInterface.sequelize.query(
      `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = '${TABLE}'
         AND COLUMN_NAME = '${COLUMN}'`,
    );
    const count = Number(result && result[0] && result[0][0] && result[0][0].count ? result[0][0].count : 0);
    if (count > 0) {
      console.log(`Column ${COLUMN} already exists on ${TABLE}, skipping.`);
      process.exit(0);
    }

    console.log(`Adding column ${COLUMN} to ${TABLE}...`);
    await queryInterface.addColumn(TABLE, COLUMN, {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'not_invited',
    });
    console.log(`✅ Column ${COLUMN} added.`);

    // 2. Backfill: mark 'active' where linked tenantUser is active
    console.log('Backfilling onboardingStatus = active...');
    await queryInterface.sequelize.query(
      `UPDATE \`${TABLE}\` ca
       INNER JOIN tenantUsers tu ON tu.userId = ca.userId AND tu.tenantId = ca.tenantId
       SET ca.${COLUMN} = 'active'
       WHERE tu.status = 'active'
         AND ca.userId IS NOT NULL`,
    );
    console.log('✅ Backfill active done.');

    // 3. Backfill: mark 'invited' where linked tenantUser is invited (and not already active)
    console.log('Backfilling onboardingStatus = invited...');
    await queryInterface.sequelize.query(
      `UPDATE \`${TABLE}\` ca
       INNER JOIN tenantUsers tu ON tu.userId = ca.userId AND tu.tenantId = ca.tenantId
       SET ca.${COLUMN} = 'invited'
       WHERE tu.status = 'invited'
         AND ca.userId IS NOT NULL
         AND ca.${COLUMN} = 'not_invited'`,
    );
    console.log('✅ Backfill invited done.');

    console.log('✅ Migration 20260430-add-onboarding-status-to-clientaccounts completed.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
