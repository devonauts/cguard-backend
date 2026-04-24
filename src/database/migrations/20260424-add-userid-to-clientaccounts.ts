require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

const TABLE_CANDIDATES = ['clientAccounts', 'client_account', 'client_accounts'];

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  for (const table of TABLE_CANDIDATES) {
    try {
      const resultCount: any = await queryInterface.sequelize.query(
        `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = 'userId'`
      );
      const count = Number(resultCount && resultCount[0] && resultCount[0][0] && resultCount[0][0].count ? resultCount[0][0].count : 0);
      if (Number(count) > 0) {
        console.log(`Column userId already exists on ${table}, skipping.`);
        continue;
      }

      const resultTableCount: any = await queryInterface.sequelize.query(
        `SELECT COUNT(*) as table_count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
      );
      const table_count = Number(resultTableCount && resultTableCount[0] && resultTableCount[0][0] && resultTableCount[0][0].table_count ? resultTableCount[0][0].table_count : 0);
      if (Number(table_count) === 0) {
        continue;
      }

      console.log(`Adding column: userId to ${table}...`);

      await queryInterface.addColumn(table, 'userId', {
        type: DataTypes.UUID,
        allowNull: true,
      });

      // Backfill: if clientAccounts.email matches users.email, set userId
      try {
        console.log(`Backfilling userId on ${table} from users table where emails match...`);
        await queryInterface.sequelize.query(
          `UPDATE \`${table}\` ca
           JOIN users u ON u.email IS NOT NULL AND u.email = ca.email
           SET ca.userId = u.id
           WHERE ca.email IS NOT NULL AND (ca.userId IS NULL OR ca.userId = '')`
        );
      } catch (backfillErr) {
        console.warn(`Backfilling userId failed for ${table}:`, (backfillErr && (backfillErr as any).message) || backfillErr);
      }

      console.log(`userId column added on ${table}`);
    } catch (error) {
      console.warn(`Migration add-userid-to-clientaccounts: error for table ${table}:`, (error && (error as any).message) || error);
    }
  }

  process.exit(0);
}

migrate();
