/**
 * Hot-path composite indexes (2026-07 perf audit, batch B).
 *
 * 1. platform_events (tenantId, createdAt) — the worker-app on-duty home screen
 *    (guardMeActivity: WHERE tenantId = ? ORDER BY createdAt DESC LIMIT ?) and
 *    the SSE poll lookback (fetchPendingEventsForUser) both filter by tenantId +
 *    createdAt, but the table only has (tenantId, recipientUserId),
 *    (deliveryStatus) and (createdAt) — so every home-screen load filesorts the
 *    tenant's whole 30-day event window.
 * 2. guardShifts (punchOutTime, scheduledEnd) — the forced clock-out scheduler
 *    runs every 60s with WHERE punchOutTime IS NULL AND scheduledEnd <= ?
 *    cross-tenant; all existing indexes are tenantId-prefixed, so it is a full
 *    table scan per minute. punchOutTime IS NULL (open shifts) is the tiny hot
 *    subset, making it the ideal leading column; scheduledEnd is the range.
 * 3. guardShifts (deletedAt, punchInTime) — the hourly RepeatedLateness sweep
 *    (WHERE punchInTime > NOW() - INTERVAL 7 DAY) full-scans the same table.
 * 4. deviceIdInformations (tenantId, userId) — every push resolves device
 *    tokens 2-3 times via WHERE tenantId = ? AND userId = ?; no existing index
 *    contains userId, so each lookup range-scans all of the tenant's devices.
 *
 * ADD INDEX is ONLINE (non-blocking) on MySQL 5.7+/8. Idempotent: each index is
 * skipped if it already exists; a single failure never aborts the rest.
 * platform_events is created lazily at server startup (ensurePlatformEventsTable,
 * whose CREATE TABLE IF NOT EXISTS never retrofits indexes), so we ensure it
 * here first — that way fresh databases get the index too.
 *
 * Run: npx ts-node src/database/migrations/z20260710-add-hotpath-indexes.ts
 */
require('dotenv').config();

import models from '../models';
import { ensurePlatformEventsTable } from '../../lib/platformEventStore';

const INDEXES: Array<{ table: string; name: string; cols: string }> = [
  // Guard home screen + SSE lookback: WHERE tenantId = ? ORDER BY createdAt DESC.
  { table: 'platform_events',      name: 'idx_pe_tenant_created',  cols: '(tenantId, createdAt)' },
  // Forced clock-out sweep (every 60s): WHERE punchOutTime IS NULL AND scheduledEnd <= ?.
  { table: 'guardShifts',          name: 'idx_gs_open_scheduled',  cols: '(punchOutTime, scheduledEnd)' },
  // RepeatedLateness hourly sweep: WHERE punchInTime > NOW() - INTERVAL 7 DAY (paranoid table).
  { table: 'guardShifts',          name: 'idx_gs_deleted_punchin', cols: '(deletedAt, punchInTime)' },
  // Push token resolution (per recipient, 2-3x per push): WHERE tenantId = ? AND userId = ?.
  { table: 'deviceIdInformations', name: 'idx_device_tenant_user', cols: '(tenantId, userId)' },
  // Clock-in relevo/passdown lookup: WHERE tenantId = ? AND stationNameId = ?
  // AND punchOutTime >= ? ORDER BY punchOutTime DESC LIMIT 1 (guardMeClockIn).
  { table: 'guardShifts',          name: 'idx_gs_relevo',          cols: '(tenantId, stationNameId, punchOutTime)' },
];

async function migrate() {
  const db = models();
  const sequelize = db.sequelize;

  // platform_events is created lazily at runtime; make sure it exists so the
  // index below lands on fresh databases too.
  try {
    await ensurePlatformEventsTable(db);
  } catch (e: any) {
    console.warn('ensurePlatformEventsTable failed (continuing):', e?.message || e);
  }

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
