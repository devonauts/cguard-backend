/**
 * Convert geo-coordinate columns from STRING/TEXT to DOUBLE so they can be used
 * numerically (and indexed). Every reader already parseFloat/Number-coerces.
 *
 * Per column: clean non-numeric / '' values first (so the ALTER doesn't coerce
 * garbage to 0), then changeColumn to DOUBLE. Idempotent — skips a column that's
 * already a floating type. MySQL-targeted (prod dialect); the cleanup REGEXP is
 * guarded to MySQL/MariaDB.
 *
 * Run: npx ts-node src/database/migrations/20260606-coords-to-double.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes, QueryTypes } from 'sequelize';

const COLS: Array<{ table: string; col: string; allowNull: boolean }> = [
  { table: 'stations', col: 'latitud', allowNull: true },
  { table: 'stations', col: 'longitud', allowNull: true },
  { table: 'businessInfos', col: 'latitud', allowNull: true },
  { table: 'businessInfos', col: 'longitud', allowNull: true },
  { table: 'patrolCheckpoints', col: 'latitud', allowNull: true },
  { table: 'patrolCheckpoints', col: 'longitud', allowNull: true },
  { table: 'patrolLogs', col: 'latitude', allowNull: false },
  { table: 'patrolLogs', col: 'longitude', allowNull: false },
];

const NUMERIC = "'^-?[0-9]+(\\\\.[0-9]+)?$'";

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const dialect = sequelize.getDialect();
  const isMysql = dialect === 'mysql' || dialect === 'mariadb';

  for (const { table, col, allowNull } of COLS) {
    let desc: any;
    try {
      desc = await qi.describeTable(table);
    } catch {
      console.log(`(skip) table ${table} not found`);
      continue;
    }
    if (!desc[col]) {
      console.log(`(skip) ${table}.${col} not found`);
      continue;
    }
    const type = String(desc[col].type || '').toLowerCase();
    if (type.includes('double') || type.includes('float') || type.includes('decimal')) {
      console.log(`(skip) ${table}.${col} already ${type}`);
      continue;
    }

    // 1) Clean values that won't cast cleanly.
    if (isMysql) {
      if (allowNull) {
        await sequelize.query(
          `UPDATE \`${table}\` SET \`${col}\` = NULL ` +
            `WHERE \`${col}\` = '' OR \`${col}\` IS NULL OR \`${col}\` NOT REGEXP ${NUMERIC}`,
          { type: QueryTypes.UPDATE },
        );
      } else {
        await sequelize.query(
          `UPDATE \`${table}\` SET \`${col}\` = '0' ` +
            `WHERE \`${col}\` = '' OR \`${col}\` IS NULL OR \`${col}\` NOT REGEXP ${NUMERIC}`,
          { type: QueryTypes.UPDATE },
        );
      }
    }

    // 2) Convert the column type.
    await qi.changeColumn(table, col, { type: DataTypes.DOUBLE, allowNull });
    console.log(`✅ ${table}.${col} -> DOUBLE`);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
