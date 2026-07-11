/**
 * List-sort composite indexes (2026-07 perf audit, batch C).
 *
 * The two biggest tables are listed per tenant sorted by a timestamp, but every
 * existing index either lacks the sort column or is not tenantId-prefixed, so
 * MySQL filesorts the tenant's whole history per page load:
 *
 * 1. guardShifts (tenantId, createdAt) — the default list order in
 *    GuardShiftRepository.findAndCountAll (WHERE tenantId = ?
 *    ORDER BY createdAt DESC) used by the CRM guard profile / post-site views
 *    and the worker app whenever no orderBy is sent.
 * 2. guardShifts (tenantId, punchInTime) — the Nómina attendance list sends
 *    orderBy=punchInTime_DESC plus a punchInTimeRange window
 *    (WHERE tenantId = ? AND punchInTime BETWEEN ? AND ?
 *    ORDER BY punchInTime DESC); idx_gs_deleted_punchin is not tenant-prefixed
 *    and idx_guardshift_active has guardNameId between tenantId and the sort.
 * 3. incidents (tenantId, createdAt) — IncidentRepository.findAndCountAll
 *    defaults to createdAt DESC (control center sends orderBy=createdAt_DESC
 *    explicitly); the table's only index is the (importHash, tenantId) unique.
 *
 * ADD INDEX is ONLINE (non-blocking) on MySQL 5.7+/8. Idempotent: each index is
 * skipped if it already exists; a single failure never aborts the rest.
 *
 * Run: npx ts-node src/database/migrations/z20260711-add-list-sort-indexes.ts
 */
require('dotenv').config();

import models from '../models';

const INDEXES: Array<{ table: string; name: string; cols: string }> = [
  // Default guard-shift list order: WHERE tenantId = ? ORDER BY createdAt DESC.
  { table: 'guardShifts', name: 'idx_gs_tenant_created',  cols: '(tenantId, createdAt)' },
  // Nómina attendance list: WHERE tenantId = ? AND punchInTime BETWEEN ? AND ?
  // ORDER BY punchInTime DESC (the CRM sends orderBy=punchInTime_DESC).
  { table: 'guardShifts', name: 'idx_gs_tenant_punchin',  cols: '(tenantId, punchInTime)' },
  // Incident lists (CRM control center / post-site / worker app):
  // WHERE tenantId = ? ORDER BY createdAt DESC.
  { table: 'incidents',   name: 'idx_inc_tenant_created', cols: '(tenantId, createdAt)' },
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
