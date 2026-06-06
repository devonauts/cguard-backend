/**
 * C13 — enforce uniqueness the audit flagged, using MySQL generated columns
 * (MySQL has no partial/filtered indexes, so the Sequelize `where: { deletedAt:
 * null }` on an index is silently ignored). A generated column that is the key
 * only while the row is "live" (and NULL otherwise) gives partial-unique
 * semantics — NULLs never collide.
 *
 *  - guardAssignments: one ACTIVE rotation assignment per (tenant, guard,
 *    station, position). Adhoc (positionId NULL) and inactive/deleted rows get a
 *    NULL key, so they never collide. (createAssignment is also idempotent for
 *    this slot, so it reuses instead of inserting a duplicate.)
 *  - clientContacts: one import per (tenant, importHash) among non-deleted rows.
 *    Manually-added contacts have importHash NULL → NULL key → never collide.
 *
 * Idempotent. Run: npx ts-node src/database/migrations/20260606-c13-unique-indexes.ts
 */
require('dotenv').config();

import models from '../models';

async function columnExists(qi: any, table: string, column: string): Promise<boolean> {
  const desc = await qi.describeTable(table).catch(() => ({}));
  return !!desc[column];
}

async function migrate() {
  const { sequelize } = models();
  const qi = sequelize.getQueryInterface();

  // guardAssignments — STORED works (no real FK constraints on this table).
  if (!(await columnExists(qi, 'guardAssignments', 'activeSlotKey'))) {
    await sequelize.query(`
      ALTER TABLE guardAssignments
        ADD COLUMN activeSlotKey VARCHAR(200) GENERATED ALWAYS AS (
          IF(status='active' AND deletedAt IS NULL AND positionId IS NOT NULL,
             CONCAT_WS('|', tenantId, guardId, stationId, positionId), NULL)) STORED
    `);
    await sequelize.query(
      `ALTER TABLE guardAssignments ADD UNIQUE INDEX uniq_guardassignment_active_slot (activeSlotKey)`,
    );
    console.log('✅ guardAssignments.uniq_guardassignment_active_slot');
  } else {
    console.log('• guardAssignments.activeSlotKey already exists, skipping');
  }

  // clientContacts — VIRTUAL (STORED forces a table rebuild that re-validates an
  // existing FK and fails); add column then index as separate statements.
  if (!(await columnExists(qi, 'clientContacts', 'importUniqKey'))) {
    await sequelize.query(`
      ALTER TABLE clientContacts
        ADD COLUMN importUniqKey VARCHAR(320) GENERATED ALWAYS AS (
          IF(deletedAt IS NULL AND importHash IS NOT NULL,
             CONCAT_WS('|', tenantId, importHash), NULL)) VIRTUAL
    `);
    await sequelize.query(
      `ALTER TABLE clientContacts ADD UNIQUE INDEX uniq_clientcontact_import (importUniqKey)`,
    );
    console.log('✅ clientContacts.uniq_clientcontact_import');
  } else {
    console.log('• clientContacts.importUniqKey already exists, skipping');
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
