/**
 * Phase A (additive): make `guardAssignment` the single source of truth for
 * ad-hoc/manual assignments too.
 *
 *   - add `kind` ENUM('rotation','adhoc') NOT NULL DEFAULT 'rotation'
 *   - add `startTime` / `endTime` VARCHAR(5) (HH:mm) for ad-hoc windows
 *   - relax `positionId` / `rotationStyleId` to NULL (ad-hoc has neither)
 *
 * Safe to run repeatedly (idempotent — checks INFORMATION_SCHEMA first).
 * Run: npx ts-node scripts/20260604-add-adhoc-to-guard-assignments.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryTypes } from 'sequelize';

const TABLE = 'guardAssignments';

async function hasColumn(sequelize: any, column: string): Promise<boolean> {
  const rows: any[] = await sequelize.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { table: TABLE, column }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
}

async function isNullable(sequelize: any, column: string): Promise<boolean> {
  const rows: any[] = await sequelize.query(
    `SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { table: TABLE, column }, type: QueryTypes.SELECT },
  );
  return rows.length > 0 && String(rows[0].IS_NULLABLE).toUpperCase() === 'YES';
}

async function migrate() {
  const { sequelize } = models();

  if (!(await hasColumn(sequelize, 'kind'))) {
    await sequelize.query(
      `ALTER TABLE ${TABLE} ADD COLUMN kind ENUM('rotation','adhoc') NOT NULL DEFAULT 'rotation'`,
    );
    console.log('✅ added column kind');
  } else {
    console.log('• kind already exists');
  }

  if (!(await hasColumn(sequelize, 'startTime'))) {
    await sequelize.query(`ALTER TABLE ${TABLE} ADD COLUMN startTime VARCHAR(5) NULL`);
    console.log('✅ added column startTime');
  } else {
    console.log('• startTime already exists');
  }

  if (!(await hasColumn(sequelize, 'endTime'))) {
    await sequelize.query(`ALTER TABLE ${TABLE} ADD COLUMN endTime VARCHAR(5) NULL`);
    console.log('✅ added column endTime');
  } else {
    console.log('• endTime already exists');
  }

  for (const col of ['positionId', 'rotationStyleId']) {
    if (!(await isNullable(sequelize, col))) {
      try {
        await sequelize.query(`ALTER TABLE ${TABLE} MODIFY COLUMN ${col} CHAR(36) NULL`);
        console.log(`✅ relaxed ${col} to NULL`);
      } catch (e: any) {
        console.error(`⚠️  could not relax ${col} to NULL:`, e?.message || e);
      }
    } else {
      console.log(`• ${col} already nullable`);
    }
  }

  console.log('Done.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
