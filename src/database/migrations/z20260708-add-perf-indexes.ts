/**
 * Performance indexes for the hottest full-table-scan queries.
 *
 * From production performance_schema (events_statements_summary_by_digest): these
 * queries ran with NO index (SUM_NO_INDEX_USED high), mostly the per-minute
 * schedulers scanning whole tables. Worst was `shifts` (~3,371 rows examined per
 * call, ~145s total). Each index below matches the exact WHERE of a live query.
 *
 * ADD INDEX on these small/medium tables is ONLINE (non-blocking) on MySQL 5.7+/8.
 * Idempotent: each index is skipped if it already exists; a single failure never
 * aborts the rest.
 *
 * Run: npx ts-node src/database/migrations/z20260708-add-perf-indexes.ts
 */
require('dotenv').config();

import models from '../models';

const INDEXES: Array<{ table: string; name: string; cols: string }> = [
  // Scheduler scans shifts by startTime range — the biggest offender.
  { table: 'shifts',             name: 'idx_shifts_deleted_start',     cols: '(deletedAt, startTime)' },
  // Polymorphic attachment lookup, called ~66k times with a full scan each.
  { table: 'files',              name: 'idx_files_owner',              cols: '(belongsToId, belongsToColumn)' },
  // Message reminder sweep: WHERE reminderSentAt IS NULL AND createdAt < ?.
  { table: 'messageReceipts',    name: 'idx_msgrcpt_reminder_created', cols: '(reminderSentAt, createdAt)' },
  // Station-order notify sweep: WHERE active AND notifyEnabled.
  { table: 'stationOrders',      name: 'idx_stationorders_active',     cols: '(active, notifyEnabled, deletedAt)' },
  // Alarm-case lookups by status.
  { table: 'alarmCases',         name: 'idx_alarmcases_status',        cols: '(status, deletedAt)' },
  // Radio-check schedulers by status/enabled.
  { table: 'radioCheckSessions', name: 'idx_rcsessions_status',        cols: '(status, deletedAt)' },
  { table: 'radioCheckEntries',  name: 'idx_rcentries_status',         cols: '(status, deletedAt)' },
  { table: 'radioCheckSettings', name: 'idx_rcsettings_enabled',       cols: '(enabled, deletedAt)' },
];

async function migrate() {
  const db = models();
  const sequelize = db.sequelize;
  for (const ix of INDEXES) {
    try {
      const [t]: any = await sequelize.query(
        `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
        { replacements: [ix.table] },
      );
      if (!t || !t.length) { console.log(`skip ${ix.name}: table ${ix.table} not found`); continue; }

      const [r]: any = await sequelize.query(
        `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
        { replacements: [ix.table, ix.name] },
      );
      if (r && r.length) { console.log(`skip ${ix.name}: already exists`); continue; }

      await sequelize.query(`ALTER TABLE \`${ix.table}\` ADD INDEX \`${ix.name}\` ${ix.cols}`);
      console.log(`created ${ix.name} on ${ix.table} ${ix.cols}`);
    } catch (e: any) {
      console.error(`FAILED ${ix.name} on ${ix.table}:`, e?.message || e);
    }
  }
  process.exit(0);
}

migrate().catch((e) => { console.error(e); process.exit(1); });
